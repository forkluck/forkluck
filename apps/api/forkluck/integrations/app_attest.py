"""Apple App Attest on the phone's sign-up: the check a native app can pass
where the web's Turnstile widget cannot run.

The phone asks for a challenge bound to its attestation key, has Apple's
Secure Enclave attest that key, and sends the attestation with its
registration. Verifying it here proves the request came from a genuine copy
of the app on a genuine Apple device, offline, against Apple's pinned root.
One key attests once; the key id is stored on the account so a captured
attestation cannot open a second one. Unset `FORKLUCK_APP_ATTEST_APP_ID`
switches the check off, the self-hosted and development default, exactly as
unset Turnstile keys do for the web.

Stdlib plus `cryptography`, which is already a dependency; the CBOR the
attestation is wrapped in needs only five of the format's major types, so it
is decoded here rather than through a new package.
"""

import base64
import binascii
import hashlib
import hmac
import time
from functools import cache
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.conf import settings
from django.utils import timezone

# Ten minutes, like an emailed code: the phone attests right after asking.
CHALLENGE_TTL_S = 600
# A real attestation is under 6 KB; anything larger is not one.
MAX_ATTESTATION_BYTES = 8192
KEY_ID_BYTES = 32
# The sixteen-byte environment marker inside authData. TestFlight and App
# Store builds attest in production; a Debug build cannot pass this check,
# which is fine because a development server leaves the setting unset.
PRODUCTION_AAGUID = b"appattest" + b"\x00" * 7
# The leaf certificate's nonce lives in this Apple extension, DER encoded as
# SEQUENCE { [1] OCTET STRING (32) }: six bytes of framing then the nonce.
NONCE_OID = x509.ObjectIdentifier("1.2.840.113635.100.8.2")
NONCE_FRAMING = bytes.fromhex("3024a1220420")
ROOT_PATH = Path(__file__).with_name("app_attest_root.pem")


class AttestationInvalid(Exception):
    """The attestation, its key or its challenge did not check out."""


def configured() -> bool:
    return bool(settings.FORKLUCK_APP_ATTEST_APP_ID)


@cache
def root_certificate() -> x509.Certificate:
    """Apple's App Attestation Root CA, checked into the repo."""
    return x509.load_pem_x509_certificate(ROOT_PATH.read_bytes())


# -- the challenge ------------------------------------------------------------


def _mac(payload: bytes) -> bytes:
    return hmac.new(settings.SECRET_KEY.encode(), payload, "sha256").digest()[:16]


def issue_challenge(key_id: bytes) -> str:
    """A challenge for one key: issued time, key id and a MAC, so nothing
    needs storing and a challenge cannot be reused for another key."""
    stamp = int(time.time()).to_bytes(8, "big")
    payload = stamp + key_id
    return base64.urlsafe_b64encode(payload + _mac(payload)).decode().rstrip("=")


def check_challenge(challenge: object, key_id: bytes) -> None:
    if not isinstance(challenge, str) or not 60 <= len(challenge) <= 120:
        raise AttestationInvalid("challenge")
    try:
        raw = base64.urlsafe_b64decode(challenge + "=" * (-len(challenge) % 4))
    except (binascii.Error, ValueError) as exc:
        raise AttestationInvalid("challenge") from exc
    if len(raw) != 8 + KEY_ID_BYTES + 16:
        raise AttestationInvalid("challenge")
    payload, mac = raw[:-16], raw[-16:]
    if not hmac.compare_digest(mac, _mac(payload)):
        raise AttestationInvalid("challenge")
    if payload[8:] != key_id:
        raise AttestationInvalid("challenge")
    issued = int.from_bytes(payload[:8], "big")
    age = time.time() - issued
    if not -60 <= age <= CHALLENGE_TTL_S:
        raise AttestationInvalid("challenge")


# -- the attestation ----------------------------------------------------------


def key_id_bytes(value: object) -> bytes:
    """The phone's key id: base64 of the SHA-256 of its public key."""
    if not isinstance(value, str) or not 40 <= len(value) <= 48:
        raise AttestationInvalid("key id")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttestationInvalid("key id") from exc
    if len(raw) != KEY_ID_BYTES:
        raise AttestationInvalid("key id")
    return raw


def verify_attestation(key_id: object, attestation: object, challenge: object) -> str:
    """Check everything Apple lists and answer the key id as stored: 64 hex
    characters. Every failure is AttestationInvalid; the caller answers one
    sentence for all of them."""
    key = key_id_bytes(key_id)
    check_challenge(challenge, key)
    if not isinstance(attestation, str) or len(attestation) > MAX_ATTESTATION_BYTES * 2:
        raise AttestationInvalid("attestation")
    try:
        blob = base64.b64decode(attestation, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttestationInvalid("attestation") from exc
    if len(blob) > MAX_ATTESTATION_BYTES:
        raise AttestationInvalid("attestation")

    parsed = _decode_cbor(blob)
    if not isinstance(parsed, dict) or parsed.get("fmt") != "apple-appattest":
        raise AttestationInvalid("format")
    statement = parsed.get("attStmt")
    auth_data = parsed.get("authData")
    chain = statement.get("x5c") if isinstance(statement, dict) else None
    if (
        not isinstance(auth_data, bytes)
        or not isinstance(chain, list)
        or len(chain) != 2
        or not all(isinstance(item, bytes) for item in chain)
    ):
        raise AttestationInvalid("statement")
    try:
        leaf = x509.load_der_x509_certificate(chain[0])
        intermediate = x509.load_der_x509_certificate(chain[1])
    except ValueError as exc:
        raise AttestationInvalid("certificate") from exc
    _verify_chain(leaf, intermediate, root_certificate(), timezone.now())

    client_data_hash = hashlib.sha256(challenge.encode()).digest()
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    if not hmac.compare_digest(_nonce_from(leaf), nonce):
        raise AttestationInvalid("nonce")

    public = leaf.public_key()
    if not isinstance(public, ec.EllipticCurvePublicKey):
        raise AttestationInvalid("key")
    point = public.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    if not hmac.compare_digest(hashlib.sha256(point).digest(), key):
        raise AttestationInvalid("key id")

    if len(auth_data) < 55:
        raise AttestationInvalid("auth data")
    app_id_hash = hashlib.sha256(settings.FORKLUCK_APP_ATTEST_APP_ID.encode()).digest()
    if not hmac.compare_digest(auth_data[:32], app_id_hash):
        raise AttestationInvalid("app id")
    if auth_data[33:37] != b"\x00\x00\x00\x00":
        raise AttestationInvalid("counter")
    if auth_data[37:53] != PRODUCTION_AAGUID:
        raise AttestationInvalid("environment")
    length = int.from_bytes(auth_data[53:55], "big")
    if auth_data[55 : 55 + length] != key:
        raise AttestationInvalid("credential")
    return key.hex()


def _verify_chain(leaf, intermediate, root, now) -> None:
    for cert, issuer in ((leaf, intermediate), (intermediate, root)):
        if cert.issuer != issuer.subject:
            raise AttestationInvalid("chain")
        if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
            raise AttestationInvalid("validity")
        algorithm = cert.signature_hash_algorithm
        public = issuer.public_key()
        if algorithm is None or not isinstance(public, ec.EllipticCurvePublicKey):
            raise AttestationInvalid("chain")
        try:
            public.verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(algorithm))
        except InvalidSignature as exc:
            raise AttestationInvalid("chain") from exc


def _nonce_from(cert: x509.Certificate) -> bytes:
    try:
        extension = cert.extensions.get_extension_for_oid(NONCE_OID)
    except x509.ExtensionNotFound as exc:
        raise AttestationInvalid("nonce") from exc
    value = extension.value.value if isinstance(extension.value, x509.UnrecognizedExtension) else b""
    if len(value) != len(NONCE_FRAMING) + 32 or not value.startswith(NONCE_FRAMING):
        raise AttestationInvalid("nonce")
    return value[len(NONCE_FRAMING) :]


# -- CBOR, the five major types an attestation uses ---------------------------


def _decode_cbor(data: bytes) -> object:
    value, end = _item(data, 0, 0)
    if end != len(data):
        raise AttestationInvalid("cbor")
    return value


def _item(data: bytes, offset: int, depth: int) -> tuple[object, int]:
    if depth > 8 or offset >= len(data):
        raise AttestationInvalid("cbor")
    initial = data[offset]
    major, info = initial >> 5, initial & 0x1F
    offset += 1
    if info < 24:
        argument = info
    elif info in (24, 25, 26, 27):
        width = 1 << (info - 24)
        if offset + width > len(data):
            raise AttestationInvalid("cbor")
        argument = int.from_bytes(data[offset : offset + width], "big")
        offset += width
    else:
        raise AttestationInvalid("cbor")
    if major == 0:
        return argument, offset
    if major in (2, 3):
        end = offset + argument
        if end > len(data):
            raise AttestationInvalid("cbor")
        chunk = bytes(data[offset:end])
        if major == 2:
            return chunk, end
        try:
            return chunk.decode("utf-8"), end
        except UnicodeDecodeError as exc:
            raise AttestationInvalid("cbor") from exc
    if major == 4:
        items: list[object] = []
        for _ in range(argument):
            value, offset = _item(data, offset, depth + 1)
            items.append(value)
        return items, offset
    if major == 5:
        pairs: dict[str, object] = {}
        for _ in range(argument):
            key, offset = _item(data, offset, depth + 1)
            if not isinstance(key, str):
                raise AttestationInvalid("cbor")
            pairs[key], offset = _item(data, offset, depth + 1)
        return pairs, offset
    raise AttestationInvalid("cbor")
