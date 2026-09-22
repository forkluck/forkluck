"""Apple App Attest on the phone's sign-up: the verifier and the register gate.

The chain is synthetic: a root, an intermediate and a leaf built here with
`cryptography`, and the module's pinned root swapped for the synthetic one.
Everything else is checked as Apple specifies it.
"""

import base64
import hashlib
import json
from datetime import timedelta
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.x509.oid import NameOID
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .integrations import app_attest
from .integrations.app_attest import AttestationInvalid
from .models import User

APP_ID = "TEAMID1234.com.forkluck.recipes"
ATTEST_ON = override_settings(
    FORKLUCK_APP_ATTEST_APP_ID=APP_ID,
    ACS_CONNECTION_STRING="synthetic",
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
ROOT = "/api/mobile/v1/"
PASSWORD = "a-long-test-passphrase-2468"


# -- a tiny CBOR encoder, the inverse of the module's decoder -----------------


def _head(major: int, count: int) -> bytes:
    if count < 24:
        return bytes([major << 5 | count])
    if count < 256:
        return bytes([major << 5 | 24, count])
    if count < 65536:
        return bytes([major << 5 | 25]) + count.to_bytes(2, "big")
    return bytes([major << 5 | 26]) + count.to_bytes(4, "big")


def cbor(value) -> bytes:
    if isinstance(value, bool):
        raise TypeError("no booleans in an attestation")
    if isinstance(value, int):
        return _head(0, value)
    if isinstance(value, bytes):
        return _head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode()
        return _head(3, len(raw)) + raw
    if isinstance(value, list):
        return _head(4, len(value)) + b"".join(cbor(item) for item in value)
    if isinstance(value, dict):
        return _head(5, len(value)) + b"".join(cbor(k) + cbor(v) for k, v in value.items())
    raise TypeError(type(value))


# -- a synthetic Apple chain --------------------------------------------------


def _name(common: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])


def _certificate(subject, public_key, issuer, signer, algorithm, extensions=()):
    now = timezone.now()
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
    )
    for extension in extensions:
        builder = builder.add_extension(extension, critical=False)
    return builder.sign(signer, algorithm)


class Chain:
    """One synthetic root and intermediate, shared by a test class."""

    def __init__(self) -> None:
        self.root_key = ec.generate_private_key(ec.SECP384R1())
        self.root = _certificate(
            _name("Synthetic App Attestation Root"), self.root_key.public_key(),
            _name("Synthetic App Attestation Root"), self.root_key, hashes.SHA384(),
        )
        self.ca_key = ec.generate_private_key(ec.SECP384R1())
        self.ca = _certificate(
            _name("Synthetic App Attestation CA 1"), self.ca_key.public_key(),
            self.root.subject, self.root_key, hashes.SHA384(),
        )

    def attestation(
        self,
        challenge: str,
        *,
        key=None,
        credential_key=None,
        app_id: str = APP_ID,
        counter: bytes = b"\x00\x00\x00\x00",
        aaguid: bytes = app_attest.PRODUCTION_AAGUID,
        nonce: bytes | None = None,
        signer=None,
    ) -> tuple[str, str]:
        """(keyId, attestation) for a challenge, with knobs for each check."""
        key = key or ec.generate_private_key(ec.SECP256R1())
        credential_key = credential_key or key
        point = credential_key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        key_id = hashlib.sha256(point).digest()
        auth_data = (
            hashlib.sha256(app_id.encode()).digest()
            + b"\x45"
            + counter
            + aaguid
            + len(key_id).to_bytes(2, "big")
            + key_id
        )
        if nonce is None:
            client_data_hash = hashlib.sha256(challenge.encode()).digest()
            nonce = hashlib.sha256(auth_data + client_data_hash).digest()
        leaf = _certificate(
            _name("Synthetic leaf"), key.public_key(), self.ca.subject,
            signer or self.ca_key, hashes.SHA256(),
            extensions=[x509.UnrecognizedExtension(app_attest.NONCE_OID, app_attest.NONCE_FRAMING + nonce)],
        )
        statement = {
            "fmt": "apple-appattest",
            "attStmt": {"x5c": [leaf.public_bytes(Encoding.DER), self.ca.public_bytes(Encoding.DER)], "receipt": b"r"},
            "authData": auth_data,
        }
        return base64.b64encode(key_id).decode(), base64.b64encode(cbor(statement)).decode()


@ATTEST_ON
class VerifierTests(TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.chain = Chain()

    def setUp(self) -> None:
        self.enterContext(patch.object(app_attest, "root_certificate", return_value=self.chain.root))

    def challenge_for(self, key_id: str) -> str:
        return app_attest.issue_challenge(base64.b64decode(key_id))

    def valid(self):
        key = ec.generate_private_key(ec.SECP256R1())
        point = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        challenge = app_attest.issue_challenge(hashlib.sha256(point).digest())
        key_id, attestation = self.chain.attestation(challenge, key=key)
        return key_id, attestation, challenge

    def test_a_genuine_attestation_answers_the_key_id_as_hex(self):
        key_id, attestation, challenge = self.valid()
        self.assertEqual(
            app_attest.verify_attestation(key_id, attestation, challenge),
            base64.b64decode(key_id).hex(),
        )

    def test_each_check_refuses_on_its_own(self):
        key = ec.generate_private_key(ec.SECP256R1())
        point = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        challenge = app_attest.issue_challenge(hashlib.sha256(point).digest())
        cases = {
            "nonce": dict(nonce=b"\x01" * 32),
            "app id": dict(app_id="OTHER.com.example"),
            "counter": dict(counter=b"\x00\x00\x00\x01"),
            "environment": dict(aaguid=b"appattestdevelop"),
            "chain": dict(signer=ec.generate_private_key(ec.SECP384R1())),
        }
        for label, knobs in cases.items():
            with self.subTest(label):
                key_id, attestation = self.chain.attestation(challenge, key=key, **knobs)
                with self.assertRaises(AttestationInvalid):
                    app_attest.verify_attestation(key_id, attestation, challenge)

    def test_the_certificate_must_hold_the_attested_key(self):
        credential = ec.generate_private_key(ec.SECP256R1())
        point = credential.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        challenge = app_attest.issue_challenge(hashlib.sha256(point).digest())
        key_id, attestation = self.chain.attestation(
            challenge, key=ec.generate_private_key(ec.SECP256R1()), credential_key=credential
        )
        with self.assertRaises(AttestationInvalid):
            app_attest.verify_attestation(key_id, attestation, challenge)

    def test_challenges_expire_are_bound_to_the_key_and_cannot_be_forged(self):
        key_id, attestation, challenge = self.valid()
        with patch("forkluck.integrations.app_attest.time.time", return_value=__import__("time").time() + 601):
            with self.assertRaises(AttestationInvalid):
                app_attest.verify_attestation(key_id, attestation, challenge)
        forged = challenge[:-2] + ("AA" if challenge[-2:] != "AA" else "BB")
        with self.assertRaises(AttestationInvalid):
            app_attest.verify_attestation(key_id, attestation, forged)
        other = self.challenge_for(base64.b64encode(b"\x07" * 32).decode())
        with self.assertRaises(AttestationInvalid):
            app_attest.verify_attestation(key_id, attestation, other)

    def test_malformed_input_is_refused_before_any_crypto(self):
        key_id, attestation, challenge = self.valid()
        for bad in (None, "", "not base64!", base64.b64encode(b"\x00" * 9000).decode(), base64.b64encode(b"\xff\xff").decode(), base64.b64encode(cbor({"fmt": "other"})).decode()):
            with self.subTest(repr(bad)[:20]):
                with self.assertRaises(AttestationInvalid):
                    app_attest.verify_attestation(key_id, bad, challenge)
        with self.assertRaises(AttestationInvalid):
            app_attest.verify_attestation("short", attestation, challenge)

    def test_the_decoder_refuses_what_an_attestation_never_carries(self):
        for data in (b"", b"\x1f", b"\x5a", b"\xa1\x01\x02", b"\x40\x00", b"\x9f"):
            with self.subTest(data.hex()):
                with self.assertRaises(AttestationInvalid):
                    app_attest._decode_cbor(data)
        self.assertEqual(app_attest._decode_cbor(cbor({"a": [1, b"b", "c"]})), {"a": [1, b"b", "c"]})


@ATTEST_ON
class RegisterGateTests(TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.chain = Chain()

    def setUp(self) -> None:
        self.enterContext(patch.object(app_attest, "root_certificate", return_value=self.chain.root))
        self.sent: list[tuple[str, str, str]] = []
        self.enterContext(patch("forkluck.verification.send_verification_code", self.fake_send))

    def fake_send(self, email, code, *, purpose):
        self.sent.append((email, code, purpose))

    def post(self, path, body):
        return Client().post(ROOT + path, json.dumps(body), "application/json")

    def attested(self):
        key = ec.generate_private_key(ec.SECP256R1())
        point = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        key_id = base64.b64encode(hashlib.sha256(point).digest()).decode()
        challenge = self.post("auth/app-attest-challenge/", {"keyId": key_id}).json()["challenge"]
        _, attestation = self.chain.attestation(challenge, key=key)
        return {"keyId": key_id, "attestation": attestation, "challenge": challenge}

    def register(self, email="new@example.com", **extra):
        return self.post(
            "auth/register/",
            {"name": "New Cook", "email": email, "password": PASSWORD, **extra},
        )

    def test_the_challenge_route_needs_a_key_id(self):
        self.assertEqual(self.post("auth/app-attest-challenge/", {}).status_code, 400)
        self.assertEqual(self.post("auth/app-attest-challenge/", {"keyId": "nope"}).status_code, 400)

    def test_an_attested_phone_registers_and_the_key_is_kept(self):
        fields = self.attested()
        response = self.register(**fields)
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json(), {"pendingVerification": True, "email": "new@example.com"})
        user = User.objects.get(email="new@example.com")
        self.assertEqual(user.app_attest_key_id, base64.b64decode(fields["keyId"]).hex())
        self.assertEqual([purpose for _, _, purpose in self.sent], ["device"])

    def test_the_same_attestation_cannot_open_a_second_account(self):
        fields = self.attested()
        self.assertEqual(self.register(**fields).status_code, 202)
        replay = self.register("second@example.com", **fields)
        self.assertEqual(replay.status_code, 400)
        self.assertEqual(replay.json()["code"], "verification_failed")
        self.assertFalse(User.objects.filter(email="second@example.com").exists())

    def test_a_missing_or_bad_attestation_is_refused_after_field_checks(self):
        missing = self.register()
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(
            missing.json(),
            {"error": "We couldn't verify this device. Try again.", "code": "verification_failed"},
        )
        fields = self.attested()
        fields["challenge"] = fields["challenge"][:-2] + "zz"
        self.assertEqual(self.register(**fields).json()["code"], "verification_failed")
        bad_password = self.register(password="short", **self.attested())
        self.assertEqual(bad_password.status_code, 400)
        self.assertNotIn("code", bad_password.json())
        self.assertFalse(User.objects.exists())

    @override_settings(FORKLUCK_APP_ATTEST_APP_ID="")
    def test_an_unconfigured_server_ignores_the_fields(self):
        response = self.register(keyId="junk", attestation="junk", challenge="junk")
        self.assertEqual(response.status_code, 202)
        self.assertIsNone(User.objects.get(email="new@example.com").app_attest_key_id)
