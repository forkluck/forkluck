"""Guest recipe links: minting, rotation, revocation, and what they serve.

The email module is patched in every test that shares, because the test
settings blank ACS_CONNECTION_STRING and an unpatched send would raise.
"""

import json
import secrets
from datetime import timedelta
from unittest import mock

from django.conf import settings
from django.test import Client, override_settings
from django.utils import timezone

from .domains.recipes.guest_links import hash_guest_token
from .domains.shared.billing import trial_ends_at
from .domains.shared.recipe_invites import claim_invitations
from .integrations.emails import EmailNotConfigured
from .models import (
    BillingAccount,
    EmailVerificationCode,
    Recipe,
    RecipeGuestLink,
    RecipeItem,
    RecipeShare,
    User,
)
from .testing import InternalApiTestCase
from .verification import issue_code

SEND = "forkluck.domains.recipes.actions.send_guest_share"
NOTIFY = "forkluck.domains.recipes.actions.send_share_notification"


class GuestLinkTestCase(InternalApiTestCase):
    """One owner, one recipe, and the two calls every test spells out."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = User.objects.create_user(
            email="guest-links-owner@example.com",
            password="a-long-test-passphrase-2468",
            name="Link Owner",
        )
        cls.recipe = Recipe.objects.create(
            user=cls.owner,
            title="Sourdough",
            code="G1",
            description="Long ferment",
            yield_amount=900.0,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=cls.recipe,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Flour",
            quantity=500,
            unit="g",
        )

    def setUp(self) -> None:
        self.client.force_login(self.owner)

    def share(
        self, email: str, *, role: str = RecipeShare.VIEWER, send=None, notify=None
    ):
        """Post one share with both mails stubbed and the commit hooks run.

        The account-holder notification is registered with on_commit, so it
        only runs inside captureOnCommitCallbacks. Its mock lands on
        self.notified rather than in the return, because most tests here are
        about the guest link and want the shorter unpack.
        """
        body = {"recipeId": str(self.recipe.id), "email": email, "role": role}
        with mock.patch(NOTIFY, notify or mock.Mock()) as notified:
            with mock.patch(SEND, send or mock.Mock()) as sent:
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.post_internal("share-recipe", body)
        self.notified = notified
        return response, sent

    def token_from(self, sent) -> str:
        return sent.call_args.kwargs["link"].rsplit("/", 1)[1]

    def mint(self, email: str = "cook@example.com") -> str:
        response, sent = self.share(email)
        self.assertEqual(response.status_code, 200)
        return self.token_from(sent)

    def verified(self, email: str, name: str) -> User:
        return User.objects.create_user(
            email=email,
            password="a-long-test-passphrase-1357",
            name=name,
            email_verified_at=timezone.now(),
        )

    def guest_get(self, token: str):
        return Client().get(
            f"/internal/v1/guest/recipes/{token}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )


class RecipeGuestLinkTests(GuestLinkTestCase):
    def test_sharing_an_unknown_address_mints_a_row_and_emails_its_link(self):
        response, sent = self.share("cook@example.com")
        self.assertEqual(response.status_code, 200)
        link = RecipeGuestLink.objects.get(recipe=self.recipe)
        self.assertEqual(link.email, "cook@example.com")
        self.assertEqual(
            response.json(),
            {
                "guest": {
                    "id": str(link.id),
                    "email": link.email,
                    "role": RecipeShare.VIEWER,
                }
            },
        )
        token = self.token_from(sent)
        self.assertEqual(
            sent.call_args.kwargs["link"],
            f"{settings.FORKLUCK_APP_ORIGIN}/shared/{token}",
        )
        self.assertEqual(hash_guest_token(token), link.token_hash)

    def test_re_sharing_rotates_the_link(self):
        old_token = self.mint()
        new_token = self.mint()
        self.assertEqual(RecipeGuestLink.objects.count(), 1)
        self.assertNotEqual(old_token, new_token)
        self.assertEqual(self.guest_get(old_token).status_code, 404)
        self.assertEqual(self.guest_get(new_token).status_code, 200)

    def test_removing_the_link_revokes_it(self):
        token = self.mint()
        link = RecipeGuestLink.objects.get()
        response = self.post_internal(
            "remove-recipe-guest-link",
            {"recipeId": str(self.recipe.id), "linkId": str(link.id)},
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(RecipeGuestLink.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 404)

    def test_the_guest_payload_carries_the_recipe_and_nothing_private(self):
        response = self.guest_get(self.mint())
        item = response.json()["item"]
        self.assertEqual(
            set(item),
            {
                "role",
                "title",
                "description",
                "yieldAmount",
                "yieldUnit",
                "servingAmount",
                "servingUnit",
                "batchSizes",
                "items",
                "steps",
                "ownerName",
            },
        )
        self.assertEqual(item["title"], "Sourdough")
        self.assertEqual(item["ownerName"], "Link Owner")
        self.assertEqual(set(item["items"][0]), {"kind", "displayName", "quantity", "unit", "preparationNote", "subrecipe"})
        dumped = json.dumps(response.json())
        for private in (
            "ingredientCostCents",
            "foodCost",
            "menuPriceCents",
            "nutrition",
            "shares",
        ):
            self.assertNotIn(private, dumped)

    def test_the_daily_invite_limit_stops_the_twenty_first(self):
        for index in range(20):
            self.mint(f"cook{index}@example.com")
        response, _ = self.share("cook20@example.com")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "Too many guest invites today. Try again tomorrow.",
        )

    def test_a_collaborator_sees_no_guest_links(self):
        self.mint()
        editor = User.objects.create_user(
            email="guest-links-editor@example.com",
            password="a-long-test-passphrase-8642",
            name="Editor",
            email_verified_at=timezone.now(),
        )
        RecipeShare.objects.create(
            recipe=self.recipe, recipient=editor, role=RecipeShare.EDITOR
        )
        client = Client()
        client.force_login(editor)
        response = self.get_internal(
            f"recipes/{self.recipe.public_id}/", client=client
        )
        self.assertEqual(response.json()["item"]["guestLinks"], [])
        owner_read = self.get_internal(f"recipes/{self.recipe.public_id}/")
        self.assertEqual(len(owner_read.json()["item"]["guestLinks"]), 1)


class GuestLinkInvariantTests(GuestLinkTestCase):
    """One test per cell of what a link depends on."""

    # --- recipient type x role ---------------------------------------------

    def test_a_registered_viewer_gets_a_share_row_not_a_link(self):
        member = self.verified("member@example.com", "Member")
        response, sent = self.share("member@example.com")
        self.assertEqual(response.json()["recipientId"], str(member.id))
        self.assertFalse(RecipeGuestLink.objects.exists())
        sent.assert_not_called()
        self.notified.assert_called_once()

    def test_a_registered_editor_gets_a_share_row(self):
        self.verified("member@example.com", "Member")
        response, _ = self.share("member@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(response.json()["role"], RecipeShare.EDITOR)

    def test_the_owners_own_address_is_refused(self):
        User.objects.filter(id=self.owner.id).update(email_verified_at=timezone.now())
        response, _ = self.share(self.owner.email)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "You already own this recipe"
        )

    # --- ownership ----------------------------------------------------------

    def test_a_stranger_cannot_share_the_recipe(self):
        stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-9753",
            name="Stranger",
        )
        client = Client()
        client.force_login(stranger)
        with mock.patch(SEND) as sent:
            response = client.post(
                "/internal/v1/actions/share-recipe/",
                data=json.dumps(
                    {"recipeId": str(self.recipe.id), "email": "cook@example.com"}
                ),
                content_type="application/json",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(RecipeGuestLink.objects.exists())
        sent.assert_not_called()

    def test_a_stranger_cannot_revoke_the_link(self):
        token = self.mint()
        link = RecipeGuestLink.objects.get()
        stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-9753",
            name="Stranger",
        )
        client = Client()
        client.force_login(stranger)
        response = self.post_internal(
            "remove-recipe-guest-link",
            {"recipeId": str(self.recipe.id), "linkId": str(link.id)},
            client=client,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.guest_get(token).status_code, 200)

    # --- token state --------------------------------------------------------

    def test_a_junk_token_is_not_found(self):
        self.assertEqual(self.guest_get("not-a-real-token").status_code, 404)

    def test_an_over_long_token_is_not_found(self):
        self.assertEqual(self.guest_get("x" * 200).status_code, 404)

    # --- send outcome -------------------------------------------------------

    def test_a_failed_send_leaves_no_link_behind(self):
        response, _ = self.share(
            "cook@example.com",
            send=mock.Mock(side_effect=EmailNotConfigured("no key")),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "The invite email could not be sent"
        )
        self.assertFalse(RecipeGuestLink.objects.exists())

    def test_a_rejected_send_leaves_no_link_behind(self):
        response, _ = self.share(
            "cook@example.com", send=mock.Mock(side_effect=ValueError("rejected"))
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(RecipeGuestLink.objects.exists())

    # --- recipe lifecycle ---------------------------------------------------

    def test_an_archived_recipe_still_serves(self):
        token = self.mint()
        Recipe.objects.filter(id=self.recipe.id).update(
            status=Recipe.STATUS_ARCHIVED
        )
        self.assertEqual(self.guest_get(token).status_code, 200)

    def test_a_deleted_recipe_takes_its_links_with_it(self):
        token = self.mint()
        Recipe.objects.filter(id=self.recipe.id).delete()
        self.assertFalse(RecipeGuestLink.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 404)

    # --- owner lifecycle ----------------------------------------------------

    def test_a_canceled_owner_keeps_serving(self):
        token = self.mint()
        BillingAccount.objects.create(
            user=self.owner,
            status="canceled",
            locked=False,
        )
        with override_settings(STRIPE_BILLING_ENABLED=True):
            self.assertEqual(self.guest_get(token).status_code, 200)

    def test_an_expired_owner_keeps_serving(self):
        # Read-only means reads still work; only deletion takes a link down.
        token = self.mint()
        after = trial_ends_at(self.owner) + timedelta(days=1)
        with (
            override_settings(STRIPE_BILLING_ENABLED=True),
            mock.patch(
                "forkluck.domains.shared.billing.current_time", return_value=after
            ),
        ):
            self.assertEqual(self.guest_get(token).status_code, 200)

    def test_a_deleting_owner_stops_serving(self):
        token = self.mint()
        row = BillingAccount.objects.create(
            user=self.owner,
            status="deleting",
            locked=True,
        )
        with override_settings(STRIPE_BILLING_ENABLED=True):
            self.assertEqual(self.guest_get(token).status_code, 404)
            row.status = "active"
            row.locked = False
            row.save(update_fields=["status", "locked"])
            self.assertEqual(self.guest_get(token).status_code, 200)

    def test_a_deactivated_owner_stops_serving(self):
        token = self.mint()
        User.objects.filter(id=self.owner.id).update(is_active=False)
        self.assertEqual(self.guest_get(token).status_code, 404)


class GuestLinkRoleTests(GuestLinkTestCase):
    """The invited role rides on the link, the mail, and both read payloads."""

    def test_an_unknown_editor_is_invited_rather_than_refused(self):
        response, sent = self.share("cook@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(response.status_code, 200)
        link = RecipeGuestLink.objects.get(recipe=self.recipe)
        self.assertEqual(link.role, RecipeShare.EDITOR)
        self.assertEqual(
            response.json(),
            {
                "guest": {
                    "id": str(link.id),
                    "email": "cook@example.com",
                    "role": RecipeShare.EDITOR,
                }
            },
        )
        self.assertEqual(sent.call_args.kwargs["role"], RecipeShare.EDITOR)

    def test_a_viewer_invite_still_reads_as_a_viewer(self):
        response, sent = self.share("cook@example.com")
        self.assertEqual(RecipeGuestLink.objects.get().role, RecipeShare.VIEWER)
        self.assertEqual(sent.call_args.kwargs["role"], RecipeShare.VIEWER)
        self.assertEqual(response.json()["guest"]["role"], RecipeShare.VIEWER)

    def test_re_sharing_restates_the_role_and_still_rotates_the_token(self):
        old_token = self.mint()
        response, sent = self.share("cook@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(RecipeGuestLink.objects.count(), 1)
        self.assertEqual(RecipeGuestLink.objects.get().role, RecipeShare.EDITOR)
        new_token = self.token_from(sent)
        self.assertNotEqual(old_token, new_token)
        self.assertEqual(self.guest_get(old_token).status_code, 404)
        self.assertEqual(self.guest_get(new_token).status_code, 200)

    def test_the_daily_invite_limit_counts_both_roles(self):
        for index in range(10):
            self.mint(f"cook{index}@example.com")
        for index in range(10, 20):
            response, _ = self.share(
                f"cook{index}@example.com", role=RecipeShare.EDITOR
            )
            self.assertEqual(response.status_code, 200)
        refused, _ = self.share("cook20@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            refused.json()["error"],
            "Too many guest invites today. Try again tomorrow.",
        )

    def test_the_guest_payload_carries_the_invited_role(self):
        viewer_token = self.mint("viewer-cook@example.com")
        self.assertEqual(
            self.guest_get(viewer_token).json()["item"]["role"], RecipeShare.VIEWER
        )
        _, sent = self.share("editor-cook@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(
            self.guest_get(self.token_from(sent)).json()["item"]["role"],
            RecipeShare.EDITOR,
        )

    def test_the_owners_list_shows_the_role_of_every_link(self):
        self.mint("viewer-cook@example.com")
        self.share("editor-cook@example.com", role=RecipeShare.EDITOR)
        response = self.get_internal(f"recipes/{self.recipe.public_id}/")
        self.assertEqual(
            {
                row["email"]: row["role"]
                for row in response.json()["item"]["guestLinks"]
            },
            {
                "viewer-cook@example.com": RecipeShare.VIEWER,
                "editor-cook@example.com": RecipeShare.EDITOR,
            },
        )


class ShareNotificationTests(GuestLinkTestCase):
    """An account holder is told by email that a recipe arrived."""

    def test_a_registered_recipient_is_mailed_a_sign_in_link(self):
        member = self.verified("member@example.com", "Member")
        response, sent = self.share("member@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            RecipeShare.objects.filter(recipe=self.recipe, recipient=member).exists()
        )
        sent.assert_not_called()
        self.notified.assert_called_once()
        self.assertEqual(self.notified.call_args.args, ("member@example.com",))
        self.assertEqual(
            self.notified.call_args.kwargs,
            {
                "owner_name": "Link Owner",
                "recipe_title": "Sourdough",
                "role": RecipeShare.EDITOR,
                "link": (
                    f"{settings.FORKLUCK_APP_ORIGIN}/login"
                    f"?next=/recipes/{self.recipe.public_id}/recipe"
                ),
            },
        )

    def test_a_failed_notification_leaves_the_share_standing(self):
        member = self.verified("member@example.com", "Member")
        with self.assertLogs("forkluck.domains.recipes.actions", "ERROR"):
            response, _ = self.share(
                "member@example.com",
                notify=mock.Mock(side_effect=EmailNotConfigured("no key")),
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            RecipeShare.objects.filter(recipe=self.recipe, recipient=member).exists()
        )


class GuestLinkClaimTests(GuestLinkTestCase):
    """Verifying an address turns the invitations waiting on it into shares."""

    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch("forkluck.verification.send_verification_code")
        self.send_code = patcher.start()
        self.addCleanup(patcher.stop)
        self.second = Recipe.objects.create(
            user=self.owner, title="Focaccia", code="G2", yield_amount=600.0
        )
        self.invitee = User.objects.create_user(
            email="cook@example.com",
            password="a-long-test-passphrase-1111",
            name="Cook",
        )
        self.own = Recipe.objects.create(
            user=self.invitee, title="Their own", code="G3", yield_amount=100.0
        )
        self.invite(self.recipe, RecipeShare.VIEWER)
        self.invite(self.second, RecipeShare.EDITOR)
        self.invite(self.own, RecipeShare.EDITOR)

    def invite(self, recipe: Recipe, role: str) -> RecipeGuestLink:
        # Minted directly: the address is the same in every case and the
        # action's own throttle and mail are not what these tests are about.
        return RecipeGuestLink.objects.create(
            recipe=recipe,
            email="cook@example.com",
            token_hash=hash_guest_token(secrets.token_urlsafe(32)),
            role=role,
        )

    def verify(self, purpose: str, path: str, body: dict) -> object:
        issue_code(self.invitee.email, purpose)
        code = self.send_code.call_args.args[1]
        return Client().post(
            path,
            data=json.dumps({"email": "cook@example.com", "code": code, **body}),
            content_type="application/json",
        )

    def roles(self) -> dict:
        return {
            share.recipe_id: share.role
            for share in RecipeShare.objects.filter(recipient=self.invitee)
        }

    def test_verifying_a_signup_claims_every_link_for_the_address(self):
        response = self.verify(
            EmailVerificationCode.PURPOSE_SIGNUP, "/api/auth/verify-email", {}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.roles(),
            {self.recipe.id: RecipeShare.VIEWER, self.second.id: RecipeShare.EDITOR},
        )
        # The link on their own recipe is dropped rather than shared back.
        self.assertFalse(RecipeGuestLink.objects.exists())

    def test_claiming_twice_changes_nothing(self):
        self.verify(
            EmailVerificationCode.PURPOSE_SIGNUP, "/api/auth/verify-email", {}
        )
        before = self.roles()
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 0)
        self.assertEqual(self.roles(), before)

    def test_the_claim_counts_the_shares_it_wrote(self):
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 2)
        self.assertEqual(RecipeGuestLink.objects.count(), 0)

    def test_a_password_reset_verification_claims_too(self):
        response = self.verify(
            EmailVerificationCode.PURPOSE_PASSWORD_RESET,
            "/api/auth/reset-password",
            {"password": "a-new-long-test-passphrase-2222"},
        )
        self.assertEqual(response.status_code, 200)
        self.invitee.refresh_from_db()
        self.assertIsNotNone(self.invitee.email_verified_at)
        self.assertEqual(
            self.roles(),
            {self.recipe.id: RecipeShare.VIEWER, self.second.id: RecipeShare.EDITOR},
        )
        self.assertFalse(RecipeGuestLink.objects.exists())
