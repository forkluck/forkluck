"""Credential encryption owned exclusively by the private connector service."""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings


class CredentialCryptoError(ValueError):
    pass


def _key() -> bytes:
    raw = settings.CONNECTORS_ENCRYPTION_KEY
    if not raw:
        raise CredentialCryptoError("CONNECTORS_ENCRYPTION_KEY is required")
    try:
        key = bytes.fromhex(raw)
    except ValueError as exc:
        raise CredentialCryptoError("CONNECTORS_ENCRYPTION_KEY must be hex") from exc
    if len(key) != 32:
        raise CredentialCryptoError("CONNECTORS_ENCRYPTION_KEY must be 32 bytes")
    return key


def encrypt(plaintext: str) -> str:
    iv = os.urandom(12)
    sealed = AESGCM(_key()).encrypt(iv, plaintext.encode(), None)
    return ":".join(
        (
            "v1",
            settings.CONNECTORS_ENCRYPTION_KEY_ID,
            base64.b64encode(iv).decode(),
            base64.b64encode(sealed).decode(),
        )
    )


def decrypt(envelope: str) -> str:
    try:
        version, _key_id, iv_b64, sealed_b64 = envelope.split(":", 3)
        if version != "v1":
            raise ValueError
        return (
            AESGCM(_key())
            .decrypt(base64.b64decode(iv_b64), base64.b64decode(sealed_b64), None)
            .decode()
        )
    except Exception as exc:
        raise CredentialCryptoError("Credential envelope cannot be decrypted") from exc
