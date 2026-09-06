"""Kitchen membership: one row that opens a whole recipe book.

A share is per recipe; a membership is the kitchen, so these tests are mostly
about what it does *not* reach — the other kitchen, the money, the settings —
and about the two grants agreeing wherever they overlap.

The email module is patched in every test that invites, because the test
settings blank ACS_CONNECTION_STRING and an unpatched send would raise.
"""

import json
from unittest import mock

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .domains.recipes.actions import (
    action_save_recipe,
    action_save_recipe_comment,
)
from .domains.shared.billing import EntitlementError
from .domains.shared.recipe_access import (
    accessible_recipe_queryset,
    editable_recipe_queryset,
    kitchen_roles,
    recipe_permission,
)
from .domains.shared.recipe_invites import claim_invitations
from .integrations.emails import EmailNotConfigured
from .models import (
    ActivityEvent,
    BillingAccount,
    EmailVerificationCode,
    KitchenInvite,
    KitchenMembership,
    Recipe,
    RecipeComment,
    RecipeShare,
    User,
)
from .testing import InternalApiTestCase
from .verification import issue_code

PASSWORD = "a-long-test-passphrase-2468"
INVITE = "forkluck.domains.workspace.actions.send_kitchen_invite"
NOTIFY = "forkluck.domains.workspace.actions.send_kitchen_member_notification"
BILLING_ON = override_settings(STRIPE_BILLING_ENABLED=True)
CLOSED = "This kitchen is closed for edits."


def verified(email: str, name: str) -> User:
    return User.objects.create_user(
        email=email,
        password=PASSWORD,
        name=name,
        email_verified_at=timezone.now(),
    )


class KitchenTestCase(InternalApiTestCase):
    """One kitchen, one recipe in it, and one account to let in."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = verified("kitchen-owner@example.com", "Kitchen Owner")
        cls.member = verified("kitchen-member@example.com", "Kitchen Member")
        cls.recipe = Recipe.objects.create(
            user=cls.owner,
            title="Sourdough",
            code="K1",
            yield_amount=900.0,
            yield_unit="g",
        )

    def join(self, role: str = RecipeShare.VIEWER) -> KitchenMembership:
        return KitchenMembership.objects.create(
            owner=self.owner, member=self.member, role=role
        )

    def fresh(self, user: User) -> User:
        """A user instance with no memoized kitchen roles on it."""
        return User.objects.get(pk=user.pk)

    def invite(self, email: str, role: str = RecipeShare.VIEWER, **mocks):
        """Post one invite with both mails stubbed and the commit hooks run."""
        with mock.patch(INVITE, mocks.get("invite") or mock.Mock()) as sent:
            with mock.patch(NOTIFY, mocks.get("notify") or mock.Mock()) as notified:
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.post_internal(
                        "invite-kitchen-member", {"email": email, "role": role}
                    )
        self.notified = notified
        return response, sent


class KitchenMembershipModelTests(TestCase):
    """The two rows the database itself refuses."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = verified("model-owner@example.com", "Model Owner")
        cls.member = verified("model-member@example.com", "Model Member")

    def test_one_membership_per_pair(self):
        KitchenMembership.objects.create(owner=self.owner, member=self.member)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                KitchenMembership.objects.create(
                    owner=self.owner, member=self.member, role=RecipeShare.EDITOR
                )

    def test_a_kitchen_cannot_be_a_member_of_itself(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                KitchenMembership.objects.create(owner=self.owner, member=self.owner)

    def test_the_self_membership_check_reaches_full_clean(self):
        with self.assertRaises(ValidationError):
            KitchenMembership(owner=self.owner, member=self.owner).full_clean()

    def test_one_invite_per_address(self):
        KitchenInvite.objects.create(owner=self.owner, email="cook@example.com")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                KitchenInvite.objects.create(
                    owner=self.owner,
                    email="cook@example.com",
                    role=RecipeShare.EDITOR,
                )

    def test_two_kitchens_may_invite_the_same_address(self):
        second = verified("model-second@example.com", "Second Owner")
        KitchenInvite.objects.create(owner=self.owner, email="cook@example.com")
        KitchenInvite.objects.create(owner=second, email="cook@example.com")
        self.assertEqual(KitchenInvite.objects.count(), 2)


class KitchenAccessTests(KitchenTestCase):
    """What the three helpers say for a viewer, an editor and a stranger."""

    def helpers(self, user: User) -> tuple[bool, bool, str | None]:
        user = self.fresh(user)
        recipe = accessible_recipe_queryset(user).filter(id=self.recipe.id).first()
        return (
            recipe is not None,
            editable_recipe_queryset(user).filter(id=self.recipe.id).exists(),
            recipe_permission(recipe or self.recipe, user),
        )

    def test_a_stranger_reaches_nothing(self):
        self.assertEqual(self.helpers(self.member), (False, False, None))

    def test_a_viewer_reads_but_cannot_edit(self):
        self.join(RecipeShare.VIEWER)
        self.assertEqual(self.helpers(self.member), (True, False, "viewer"))

    def test_an_editor_reads_and_edits(self):
        self.join(RecipeShare.EDITOR)
        self.assertEqual(self.helpers(self.member), (True, True, "editor"))

    def test_the_owner_stays_the_owner(self):
        self.join(RecipeShare.EDITOR)
        self.assertEqual(self.helpers(self.owner), (True, True, "owner"))

    def test_a_membership_is_dormant_until_the_address_verifies(self):
        User.objects.filter(id=self.member.id).update(email_verified_at=None)
        self.join(RecipeShare.EDITOR)
        self.assertEqual(self.helpers(self.member), (False, False, None))
        self.assertEqual(kitchen_roles(self.fresh(self.member)), {})

    def test_kitchen_roles_is_memoized_on_the_user(self):
        self.join(RecipeShare.EDITOR)
        member = self.fresh(self.member)
        with self.assertNumQueries(1):
            kitchen_roles(member)
            kitchen_roles(member)
        self.assertEqual(kitchen_roles(member), {self.owner.id: RecipeShare.EDITOR})

    def test_the_recipe_queryset_does_not_repeat_a_row(self):
        """Both grants at once still list the recipe once."""
        self.join(RecipeShare.EDITOR)
        RecipeShare.objects.create(
            recipe=self.recipe, recipient=self.member, role=RecipeShare.EDITOR
        )
        member = self.fresh(self.member)
        self.assertEqual(len(list(accessible_recipe_queryset(member))), 1)
        self.assertEqual(len(list(editable_recipe_queryset(member))), 1)


class SharePrecedenceTests(KitchenTestCase):
    """Where a share and a membership overlap, the stronger role wins."""

    MATRIX = [
        (None, None, None),
        (RecipeShare.VIEWER, None, "viewer"),
        (RecipeShare.EDITOR, None, "editor"),
        (None, RecipeShare.VIEWER, "viewer"),
        (None, RecipeShare.EDITOR, "editor"),
        (RecipeShare.VIEWER, RecipeShare.VIEWER, "viewer"),
        (RecipeShare.VIEWER, RecipeShare.EDITOR, "editor"),
        (RecipeShare.EDITOR, RecipeShare.VIEWER, "editor"),
        (RecipeShare.EDITOR, RecipeShare.EDITOR, "editor"),
    ]

    def test_the_permission_and_the_editable_queryset_agree(self):
        for share_role, kitchen_role, expected in self.MATRIX:
            with self.subTest(share=share_role, kitchen=kitchen_role):
                RecipeShare.objects.filter(recipient=self.member).delete()
                KitchenMembership.objects.filter(member=self.member).delete()
                if share_role is not None:
                    RecipeShare.objects.create(
                        recipe=self.recipe, recipient=self.member, role=share_role
                    )
                if kitchen_role is not None:
                    self.join(kitchen_role)
                member = self.fresh(self.member)
                row = (
                    accessible_recipe_queryset(member)
                    .filter(id=self.recipe.id)
                    .first()
                )
                self.assertEqual(
                    recipe_permission(row or self.recipe, member), expected
                )
                self.assertEqual(row is not None, expected is not None)
                self.assertEqual(
                    editable_recipe_queryset(member)
                    .filter(id=self.recipe.id)
                    .exists(),
                    expected == "editor",
                )


class KitchenInviteActionTests(KitchenTestCase):
    """Inviting an account, inviting an address, and the mails that follow."""

    def setUp(self) -> None:
        self.client.force_login(self.owner)

    def test_inviting_an_account_creates_the_membership_and_mails_it(self):
        response, sent = self.invite(self.member.email, RecipeShare.EDITOR)
        self.assertEqual(response.status_code, 200)
        membership = KitchenMembership.objects.get(owner=self.owner)
        self.assertEqual(membership.member_id, self.member.id)
        self.assertEqual(membership.role, RecipeShare.EDITOR)
        self.assertEqual(
            response.json(),
            {
                "id": str(membership.id),
                "memberId": str(self.member.id),
                "name": "Kitchen Member",
                "email": self.member.email,
                "role": RecipeShare.EDITOR,
            },
        )
        sent.assert_not_called()
        self.assertEqual(self.notified.call_args.args, (self.member.email,))
        self.assertEqual(
            self.notified.call_args.kwargs,
            {
                "owner_name": "Kitchen Owner",
                "role": RecipeShare.EDITOR,
                "link": "http://localhost:3000/login?next=/recipes",
            },
        )

    def test_inviting_an_unknown_address_creates_an_invite_and_mails_it(self):
        response, sent = self.invite("cook@example.com", RecipeShare.EDITOR)
        self.assertEqual(response.status_code, 200)
        invite = KitchenInvite.objects.get(owner=self.owner)
        self.assertEqual(
            response.json(),
            {
                "invite": {
                    "id": str(invite.id),
                    "email": "cook@example.com",
                    "role": RecipeShare.EDITOR,
                }
            },
        )
        self.assertFalse(KitchenMembership.objects.exists())
        self.assertEqual(sent.call_args.args, ("cook@example.com",))
        self.assertEqual(
            sent.call_args.kwargs,
            {
                "owner_name": "Kitchen Owner",
                "role": RecipeShare.EDITOR,
                "link": "http://localhost:3000/login",
            },
        )

    def test_an_unverified_account_is_invited_rather_than_joined(self):
        User.objects.filter(id=self.member.id).update(email_verified_at=None)
        response, sent = self.invite(self.member.email)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(KitchenMembership.objects.exists())
        self.assertTrue(KitchenInvite.objects.filter(email=self.member.email).exists())
        sent.assert_called_once()

    def test_the_mails_only_go_out_once_the_row_is_committed(self):
        with mock.patch(INVITE) as sent:
            with self.captureOnCommitCallbacks(execute=False):
                self.post_internal(
                    "invite-kitchen-member", {"email": "cook@example.com"}
                )
            sent.assert_not_called()
        self.assertTrue(KitchenInvite.objects.exists())

    def test_a_failed_invite_mail_leaves_the_row(self):
        """The address is the credential, not a token in the mail, so a mail
        that never leaves costs a nudge rather than the invitation."""
        with self.assertLogs("forkluck.domains.workspace.actions", "ERROR"):
            response, _ = self.invite(
                "cook@example.com",
                invite=mock.Mock(side_effect=EmailNotConfigured("no key")),
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(KitchenInvite.objects.filter(email="cook@example.com").exists())

    def test_a_failed_notification_leaves_the_membership(self):
        with self.assertLogs("forkluck.domains.workspace.actions", "ERROR"):
            response, _ = self.invite(
                self.member.email,
                notify=mock.Mock(side_effect=EmailNotConfigured("no key")),
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(KitchenMembership.objects.filter(member=self.member).exists())

    def test_inviting_yourself_is_refused(self):
        response, _ = self.invite(self.owner.email)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "You already own this kitchen"
        )
        self.assertFalse(KitchenMembership.objects.exists())

    def test_an_unknown_role_is_refused(self):
        response = self.post_internal(
            "invite-kitchen-member", {"email": "cook@example.com", "role": "chef"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid role")

    def test_re_inviting_restates_the_role_on_the_same_row(self):
        self.invite(self.member.email, RecipeShare.VIEWER)
        self.invite(self.member.email, RecipeShare.EDITOR)
        self.invite("cook@example.com", RecipeShare.VIEWER)
        self.invite("cook@example.com", RecipeShare.EDITOR)
        self.assertEqual(
            KitchenMembership.objects.get(owner=self.owner).role, RecipeShare.EDITOR
        )
        self.assertEqual(
            KitchenInvite.objects.get(owner=self.owner).role, RecipeShare.EDITOR
        )

    def test_the_owner_changes_a_role_and_removes_a_member(self):
        membership = self.join(RecipeShare.VIEWER)
        response = self.post_internal(
            "update-kitchen-member",
            {"memberId": str(self.member.id), "role": RecipeShare.EDITOR},
        )
        self.assertEqual(response.status_code, 200)
        membership.refresh_from_db()
        self.assertEqual(membership.role, RecipeShare.EDITOR)

        response = self.post_internal(
            "remove-kitchen-member", {"membershipId": str(membership.id)}
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(KitchenMembership.objects.exists())

    def test_a_member_leaves_with_the_same_slug(self):
        membership = self.join(RecipeShare.EDITOR)
        self.client.force_login(self.member)
        response = self.post_internal(
            "remove-kitchen-member", {"membershipId": str(membership.id)}
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(KitchenMembership.objects.exists())

    def test_the_owner_revokes_a_pending_invite(self):
        invite = KitchenInvite.objects.create(
            owner=self.owner, email="cook@example.com"
        )
        response = self.post_internal(
            "remove-kitchen-invite", {"inviteId": str(invite.id)}
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(KitchenInvite.objects.exists())


class KitchenClaimTests(KitchenTestCase):
    """Verifying an address turns the kitchens waiting on it into memberships."""

    def setUp(self) -> None:
        patcher = mock.patch("forkluck.verification.send_verification_code")
        self.send_code = patcher.start()
        self.addCleanup(patcher.stop)
        self.second = verified("claim-second@example.com", "Second Kitchen")
        self.invitee = User.objects.create_user(
            email="cook@example.com", password=PASSWORD, name="Cook"
        )
        KitchenInvite.objects.create(
            owner=self.owner, email="cook@example.com", role=RecipeShare.EDITOR
        )
        KitchenInvite.objects.create(
            owner=self.second, email="COOK@example.com", role=RecipeShare.VIEWER
        )
        # An invite the address ends up owning: dropped, never claimed back.
        KitchenInvite.objects.create(owner=self.invitee, email="cook@example.com")

    def verify(self) -> object:
        issue_code(self.invitee.email, EmailVerificationCode.PURPOSE_SIGNUP)
        code = self.send_code.call_args.args[1]
        return Client().post(
            "/api/auth/verify-email",
            data=json.dumps({"email": "cook@example.com", "code": code}),
            content_type="application/json",
        )

    def roles(self) -> dict:
        return {
            row.owner_id: row.role
            for row in KitchenMembership.objects.filter(member=self.invitee)
        }

    def test_verifying_claims_every_kitchen_waiting_on_the_address(self):
        response = self.verify()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.roles(),
            {
                self.owner.id: RecipeShare.EDITOR,
                self.second.id: RecipeShare.VIEWER,
            },
        )
        # Including the one on their own kitchen, which is simply dropped.
        self.assertFalse(KitchenInvite.objects.exists())

    def test_claiming_twice_changes_nothing(self):
        self.verify()
        before = self.roles()
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 0)
        self.assertEqual(self.roles(), before)

    def test_the_claim_counts_the_memberships_it_wrote(self):
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 2)

    def test_a_claimed_kitchen_is_readable_at_once(self):
        self.verify()
        self.invitee.refresh_from_db()
        self.assertTrue(
            accessible_recipe_queryset(self.invitee)
            .filter(id=self.recipe.id)
            .exists()
        )


class KitchenBrowseTests(KitchenTestCase):
    """The list is one kitchen at a time; detail and search are not."""

    def setUp(self) -> None:
        self.join(RecipeShare.VIEWER)
        self.own = Recipe.objects.create(
            user=self.member, title="Their own", code="M1", yield_amount=100.0
        )
        self.client.force_login(self.member)

    def titles(self, params: dict | None = None) -> list[str]:
        response = self.get_internal("recipes/", params or {})
        self.assertEqual(response.status_code, 200)
        return [row["title"] for row in response.json()["items"]]

    def test_the_default_list_is_the_callers_own_kitchen(self):
        self.assertEqual(self.titles(), ["Their own"])

    def test_the_kitchen_parameter_lists_that_kitchen(self):
        self.assertEqual(
            self.titles({"kitchen": str(self.owner.id)}), ["Sourdough"]
        )

    def test_the_caller_may_ask_for_their_own_kitchen_by_id(self):
        self.assertEqual(
            self.titles({"kitchen": str(self.member.id)}), ["Their own"]
        )

    def test_a_kitchen_the_caller_does_not_belong_to_is_refused(self):
        stranger = verified("browse-stranger@example.com", "Stranger")
        response = self.get_internal("recipes/", {"kitchen": str(stranger.id)})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid kitchen")

    def test_a_malformed_kitchen_is_refused(self):
        response = self.get_internal("recipes/", {"kitchen": "not-a-uuid"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid kitchen")

    def test_has_any_recipe_answers_for_the_kitchen_on_screen(self):
        Recipe.objects.filter(user=self.member).delete()
        empty = self.get_internal("recipes/").json()
        self.assertFalse(empty["hasAnyRecipe"])
        full = self.get_internal("recipes/", {"kitchen": str(self.owner.id)}).json()
        self.assertTrue(full["hasAnyRecipe"])

    def test_recipe_detail_finds_a_kitchen_recipe_without_the_parameter(self):
        response = self.get_internal(f"recipes/{self.recipe.public_id}/")
        self.assertEqual(response.status_code, 200)
        item = response.json()["item"]
        self.assertEqual(item["title"], "Sourdough")
        self.assertEqual(item["permission"], "viewer")

    def test_search_finds_a_kitchen_recipe(self):
        response = self.get_internal("search-index/", {"q": "Sourdough"})
        self.assertEqual(response.status_code, 200)
        self.assertIn(
            "Sourdough", [row["label"] for row in response.json()["items"]]
        )

    def test_a_member_sees_no_costs(self):
        response = self.get_internal("recipes/", {"kitchen": str(self.owner.id)})
        row = response.json()["items"][0]
        self.assertIsNone(row["menuPriceCents"])


@BILLING_ON
class CreateInKitchenTests(KitchenTestCase):
    """A recipe an editor creates belongs to the kitchen, not to them."""

    def setUp(self) -> None:
        self.join(RecipeShare.EDITOR)
        self.client.force_login(self.member)

    def create(self, **body):
        return self.post_internal(
            "save-recipe",
            {"id": None, "ownerId": str(self.owner.id), "title": "Focaccia", **body},
        )

    def test_the_recipe_lands_in_the_owners_kitchen(self):
        response = self.create()
        self.assertEqual(response.status_code, 200)
        saved = response.json()
        self.assertEqual(saved["ownerId"], str(self.owner.id))
        row = Recipe.objects.get(id=saved["id"])
        self.assertEqual(row.user_id, self.owner.id)
        self.assertEqual(Recipe.objects.filter(user=self.member).count(), 0)

    def test_the_creator_is_an_editor_of_what_they_made(self):
        row = Recipe.objects.get(id=self.create().json()["id"])
        self.assertEqual(recipe_permission(row, self.fresh(self.member)), "editor")

    def test_the_activity_line_is_the_owners_with_the_member_as_actor(self):
        self.create()
        event = ActivityEvent.objects.get(resource_type="recipe", event="added")
        self.assertEqual(event.user_id, self.owner.id)
        self.assertEqual(event.actor_id, self.member.id)
        self.assertEqual(event.actor_name, "Kitchen Member")

    def test_the_code_comes_from_the_owners_sequence(self):
        Recipe.objects.create(user=self.member, title="Theirs", code="RCP-0500")
        row = Recipe.objects.get(id=self.create().json()["id"])
        self.assertNotEqual(row.code, "RCP-0501")

    def test_the_owners_cap_is_what_stops_the_member(self):
        Recipe.objects.bulk_create(
            Recipe(user=self.owner, title=f"Filler {n}", code=f"F-{n}")
            for n in range(9)
        )
        response = self.create()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.json(),
            {
                "error": (
                    "This kitchen has reached its recipe limit. Ask the owner "
                    "to upgrade."
                ),
                "code": "recipe_limit_reached",
            },
        )

    def test_the_owners_own_cap_message_is_unchanged(self):
        Recipe.objects.bulk_create(
            Recipe(user=self.owner, title=f"Filler {n}", code=f"F-{n}")
            for n in range(9)
        )
        with self.assertRaises(EntitlementError) as caught:
            action_save_recipe(self.owner, {"id": None, "title": "Eleventh"})
        self.assertIn("Free plan", str(caught.exception))

    def test_a_locked_kitchen_refuses_the_create(self):
        BillingAccount.objects.create(
            user=self.owner, status="deleting", locked=True
        )
        response = self.create()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], CLOSED)
        self.assertEqual(Recipe.objects.count(), 1)

    def test_a_viewer_cannot_create_in_the_kitchen(self):
        KitchenMembership.objects.filter(member=self.member).update(
            role=RecipeShare.VIEWER
        )
        response = self.create()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "Kitchen not found or read-only"
        )

    def test_a_kitchen_the_caller_does_not_belong_to_is_refused(self):
        stranger = verified("create-stranger@example.com", "Stranger")
        response = self.create(ownerId=str(stranger.id))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "Kitchen not found or read-only"
        )

    def test_a_kitchen_cannot_be_named_while_editing(self):
        response = self.create(id=str(self.recipe.id))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"],
            "A kitchen can be chosen only when creating a recipe",
        )


@BILLING_ON
class LockedKitchenTests(KitchenTestCase):
    """A closed workspace stops being written to, and keeps being read."""

    def setUp(self) -> None:
        self.join(RecipeShare.EDITOR)
        BillingAccount.objects.create(
            user=self.owner, status="deleting", locked=True
        )
        self.client.force_login(self.member)

    def test_a_member_cannot_save_the_owners_recipe(self):
        response = self.post_internal(
            "save-recipe", {"id": str(self.recipe.id), "title": "Renamed"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], CLOSED)
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.title, "Sourdough")

    def test_a_member_cannot_comment_on_the_owners_recipe(self):
        response = self.post_internal(
            "save-recipe-comment",
            {"recipeId": str(self.recipe.id), "body": "Looks good"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], CLOSED)
        self.assertFalse(RecipeComment.objects.exists())

    def test_the_read_still_serves(self):
        response = self.get_internal(f"recipes/{self.recipe.public_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["item"]["title"], "Sourdough")


class KitchenIsolationTests(KitchenTestCase):
    """A membership is one kitchen. Everything else stays where it was."""

    def setUp(self) -> None:
        self.join(RecipeShare.VIEWER)
        self.other_owner = verified("other-owner@example.com", "Other Owner")
        self.other_recipe = Recipe.objects.create(
            user=self.other_owner, title="Not yours", code="O1", yield_amount=1.0
        )
        self.client.force_login(self.member)

    def test_a_member_of_one_kitchen_reaches_nothing_in_another(self):
        member = self.fresh(self.member)
        self.assertFalse(
            accessible_recipe_queryset(member)
            .filter(id=self.other_recipe.id)
            .exists()
        )
        response = self.get_internal(f"recipes/{self.other_recipe.public_id}/")
        self.assertIsNone(response.json()["item"])

    def test_the_other_kitchen_is_not_a_browse_parameter(self):
        response = self.get_internal(
            "recipes/", {"kitchen": str(self.other_owner.id)}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid kitchen")

    def test_the_members_read_shows_only_the_callers_own_rows(self):
        KitchenInvite.objects.create(owner=self.owner, email="pending@example.com")
        response = self.get_internal("kitchen-members/")
        self.assertEqual(response.status_code, 200)
        # The member owns an empty kitchen of their own; the owner's rows are
        # not theirs to see.
        self.assertEqual(response.json(), {"members": [], "invites": []})

        self.client.force_login(self.owner)
        payload = self.get_internal("kitchen-members/").json()
        self.assertEqual(
            payload,
            {
                "members": [
                    {
                        "id": str(
                            KitchenMembership.objects.get(owner=self.owner).id
                        ),
                        "memberId": str(self.member.id),
                        "name": "Kitchen Member",
                        "email": self.member.email,
                        "role": RecipeShare.VIEWER,
                    }
                ],
                "invites": [
                    {
                        "id": str(KitchenInvite.objects.get().id),
                        "email": "pending@example.com",
                        "role": RecipeShare.VIEWER,
                    }
                ],
            },
        )

    def test_the_session_lists_the_kitchen_the_caller_belongs_to(self):
        payload = self.get_internal("session/").json()
        self.assertEqual(
            payload["kitchens"],
            [
                {
                    "id": str(KitchenMembership.objects.get(owner=self.owner).id),
                    "ownerId": str(self.owner.id),
                    "ownerName": "Kitchen Owner",
                    "role": RecipeShare.VIEWER,
                }
            ],
        )
        self.assertEqual(payload["billing"]["recipeCount"], 0)

    def test_the_owners_session_lists_no_kitchen_of_their_own(self):
        self.client.force_login(self.owner)
        payload = self.get_internal("session/").json()
        self.assertEqual(payload["kitchens"], [])
        self.assertEqual(payload["billing"]["recipeCount"], 1)

    def test_a_viewer_cannot_save_or_comment(self):
        save = self.post_internal(
            "save-recipe", {"id": str(self.recipe.id), "title": "Renamed"}
        )
        self.assertEqual(save.status_code, 400)
        self.assertEqual(
            save.json()["error"], "Recipe not found or not editable"
        )
        comment = self.post_internal(
            "save-recipe-comment",
            {"recipeId": str(self.recipe.id), "body": "Hello"},
        )
        self.assertEqual(comment.status_code, 400)
        self.assertEqual(comment.json()["error"], "Recipe is read-only")

    def test_an_editor_may_comment(self):
        KitchenMembership.objects.filter(member=self.member).update(
            role=RecipeShare.EDITOR
        )
        response = self.post_internal(
            "save-recipe-comment",
            {"recipeId": str(self.recipe.id), "body": "Hello"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(RecipeComment.objects.get().author_id, self.member.id)

    def test_a_removed_member_loses_everything_on_the_next_request(self):
        KitchenMembership.objects.filter(member=self.member).delete()
        self.assertEqual(
            self.get_internal("recipes/", {"kitchen": str(self.owner.id)}).status_code,
            400,
        )
        self.assertIsNone(
            self.get_internal(f"recipes/{self.recipe.public_id}/").json()["item"]
        )
        self.assertEqual(self.get_internal("session/").json()["kitchens"], [])

    def test_an_unverified_member_has_nothing(self):
        User.objects.filter(id=self.member.id).update(email_verified_at=None)
        self.assertIsNone(
            self.get_internal(f"recipes/{self.recipe.public_id}/").json()["item"]
        )
        self.assertEqual(self.get_internal("session/").json()["kitchens"], [])
        self.assertEqual(
            self.get_internal("recipes/", {"kitchen": str(self.owner.id)}).status_code,
            400,
        )

    def test_a_member_reaches_no_money_of_the_kitchen(self):
        """Nothing substitutes the owner for the caller, so the member's own
        empty tenant is what the money reads answer with."""
        response = self.get_internal("ingredients/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"], [])
        settings_payload = self.get_internal("business-settings/").json()
        self.assertNotEqual(
            settings_payload["currencyCode"], "ZZZ"
        )  # their own defaults, not a row of the kitchen's

    def test_a_member_cannot_comment_through_another_kitchen(self):
        response = self.post_internal(
            "save-recipe-comment",
            {"recipeId": str(self.other_recipe.id), "body": "Hello"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Recipe not found")

    def test_action_save_recipe_comment_refuses_a_foreign_recipe(self):
        with self.assertRaises(ValueError):
            action_save_recipe_comment(
                self.fresh(self.member),
                {"recipeId": str(self.other_recipe.id), "body": "Hello"},
            )
