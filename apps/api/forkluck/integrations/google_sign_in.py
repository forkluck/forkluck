"""Google's server-side OpenID Connect authorization-code protocol.

ID tokens are accepted only from our own TLS token exchange with Google, never
from a browser. OpenID Connect Core 3.1.3.7 permits TLS server validation in
place of signature verification for that back channel. We decode the payload
without verifying its signature and still validate issuer, audience, expiry,
nonce and verified email. No access/refresh token is stored.
https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
"""

import base64
import hashlib
import http.client
import json
import math
import secrets
import time
import urllib.parse
import urllib.request

from django.conf import settings


class GoogleSignInError(Exception):
    """The exchange or identity claims could not be trusted."""


class GoogleUnverifiedEmail(GoogleSignInError):
    """Google has not verified the claimed address."""


def is_configured() -> bool:
    return bool(settings.GOOGLE_SIGN_IN_CLIENT_ID and settings.GOOGLE_SIGN_IN_CLIENT_SECRET)


def redirect_uri() -> str:
    return settings.FORKLUCK_APP_ORIGIN.rstrip("/") + "/api/auth/google/callback"


def new_code_verifier() -> str:
    return secrets.token_urlsafe(32)


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def authorize_url(state: str, nonce: str, code_challenge: str) -> str:
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": settings.GOOGLE_SIGN_IN_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
        "prompt": "select_account",
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })


def exchange_code(code: str, verifier: str) -> str:
    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=urllib.parse.urlencode({
            "client_id": settings.GOOGLE_SIGN_IN_CLIENT_ID,
            "client_secret": settings.GOOGLE_SIGN_IN_CLIENT_SECRET,
            "redirect_uri": redirect_uri(),
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read())
    except (OSError, ValueError, http.client.HTTPException) as exc:
        raise GoogleSignInError("Token exchange failed") from exc
    if not isinstance(body, dict) or not isinstance(body.get("id_token"), str) or not body["id_token"]:
        raise GoogleSignInError("Missing ID token")
    return body["id_token"]


def decode_id_token(token: str) -> dict:
    try:
        _, payload, _ = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, UnicodeError) as exc:
        raise GoogleSignInError("Invalid ID token") from exc
    if not isinstance(claims, dict):
        raise GoogleSignInError("Invalid ID token claims")
    return claims


def validate_claims(claims: dict, nonce: str) -> dict[str, str]:
    expiry = claims.get("exp")
    subject = claims.get("sub")
    email = claims.get("email")
    claimed_nonce = claims.get("nonce")
    if (
        claims.get("iss") not in ("https://accounts.google.com", "accounts.google.com")
        or claims.get("aud") != settings.GOOGLE_SIGN_IN_CLIENT_ID
        or type(expiry) not in (int, float)
        or not 0 < expiry < math.inf
        or expiry <= time.time()
        or not isinstance(claimed_nonce, str)
        or not secrets.compare_digest(claimed_nonce.encode(), nonce.encode())
        or not isinstance(subject, str) or not subject.strip() or len(subject) > 255
        or not isinstance(email, str) or not email.strip() or len(email) > 254
        or "@" not in email
    ):
        raise GoogleSignInError("Invalid identity claims")
    if claims.get("email_verified") is not True:
        raise GoogleUnverifiedEmail("Email is not verified")
    name = claims.get("name")
    return {
        "sub": subject,
        "email": email.strip().lower(),
        "name": name[:150] if isinstance(name, str) else "",
    }
