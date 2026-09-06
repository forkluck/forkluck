"""Encryption at rest for provider OAuth tokens.

Envelope format: ``v1:<keyId>:<b64 iv>:<b64 tag>:<b64 ciphertext>`` — AES-256-GCM
with a 12-byte IV and 16-byte tag. Writes always use the current key
(FORKLUCK_TOKEN_ENCRYPTION_KEY / _KEY_ID); reads accept any key in the
registry (FORKLUCK_TOKEN_ENCRYPTION_KEYS, a JSON object of keyId -> 64-hex
key) so keys can rotate with dual-read before old envelopes are rewritten.
"""

import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ENVELOPE_VERSION = "v1"
IV_BYTES = 12
KEY_ID_MAX_LENGTH = 64


class TokenCryptoError(Exception):
    pass


def _validate_key_id(key_id: str) -> str:
    """The envelope is colon-delimited and read back by exact part count, so a
    key id carrying ':' would write tokens that can never decrypt."""
    if not key_id or ":" in key_id or len(key_id) > KEY_ID_MAX_LENGTH:
        raise TokenCryptoError(
            f"Token encryption key id {key_id!r} is not usable — it must be "
            f"non-empty, at most {KEY_ID_MAX_LENGTH} characters, and contain "
            "no ':'"
        )
    return key_id


def _parse_key(key_id: str, value: str) -> bytes:
    try:
        key = bytes.fromhex(value.strip())
    except ValueError as exc:
        raise TokenCryptoError(
            f"Token encryption key {key_id!r} is not valid hex"
        ) from exc
    if len(key) != 32:
        raise TokenCryptoError(
            f"Token encryption key {key_id!r} must be 32 bytes (64 hex chars)"
        )
    return key


def _key_registry() -> tuple[str, dict[str, bytes]]:
    """Return (current key id, {key id: key}). Read per call, not at import —
    tests override the environment and a missing key must fail the operation
    that needs it, not module import."""
    primary = os.getenv("FORKLUCK_TOKEN_ENCRYPTION_KEY", "")
    if not primary:
        raise TokenCryptoError(
            "FORKLUCK_TOKEN_ENCRYPTION_KEY is not set — cannot handle "
            "provider tokens"
        )
    current_id = _validate_key_id(
        os.getenv("FORKLUCK_TOKEN_ENCRYPTION_KEY_ID", "") or "default"
    )
    keys = {current_id: _parse_key(current_id, primary)}
    extra = os.getenv("FORKLUCK_TOKEN_ENCRYPTION_KEYS", "")
    if extra:
        try:
            parsed = json.loads(extra)
        except json.JSONDecodeError as exc:
            raise TokenCryptoError(
                "FORKLUCK_TOKEN_ENCRYPTION_KEYS is not valid JSON"
            ) from exc
        if not isinstance(parsed, dict):
            raise TokenCryptoError(
                "FORKLUCK_TOKEN_ENCRYPTION_KEYS must be a JSON object"
            )
        for key_id, value in parsed.items():
            checked = _validate_key_id(str(key_id))
            keys.setdefault(checked, _parse_key(checked, str(value)))
    return current_id, keys


def encrypt_token(plaintext: str) -> str:
    current_id, keys = _key_registry()
    iv = os.urandom(IV_BYTES)
    sealed = AESGCM(keys[current_id]).encrypt(iv, plaintext.encode("utf-8"), None)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    parts = [
        ENVELOPE_VERSION,
        current_id,
        base64.b64encode(iv).decode(),
        base64.b64encode(tag).decode(),
        base64.b64encode(ciphertext).decode(),
    ]
    return ":".join(parts)


def decrypt_token(envelope: str) -> str:
    parts = envelope.split(":")
    if len(parts) != 5 or parts[0] != ENVELOPE_VERSION:
        raise TokenCryptoError("Token envelope format is not recognized")
    _, key_id, iv_b64, tag_b64, ct_b64 = parts
    _, keys = _key_registry()
    key = keys.get(key_id)
    if key is None:
        raise TokenCryptoError(f"Token encryption key {key_id!r} is not available")
    try:
        iv = base64.b64decode(iv_b64)
        tag = base64.b64decode(tag_b64)
        ciphertext = base64.b64decode(ct_b64)
        plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, None)
    except Exception as exc:
        raise TokenCryptoError("Token envelope failed to decrypt") from exc
    return plaintext.decode("utf-8")
