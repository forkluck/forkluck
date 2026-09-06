"""Recipe books: sharing a selection, what the link serves, and its end.

A book is what an address with no account gets when several recipes are
shared at once. The email module is patched in every test that shares,
because the test settings blank ACS_CONNECTION_STRING and an unpatched send
would raise.
"""

import json
import secrets
import uuid
from unittest import mock

from django.conf import settings
from django.test import Client, override_settings
from django.utils import timezone

from .domains.recipes.guest_links import hash_guest_token
from .domains.shared.recipe_invites import claim_invitations
from .integrations.emails import EmailNotConfigured
from .models import (
    BillingAccount,
    EmailVerificationCode,
    Recipe,
    RecipeBook,
    RecipeBookRecipe,
    RecipeGuestLink,
    RecipeItem,
    RecipeShare,
    User,
)
from .testing import InternalApiTestCase
from .verification import issue_code

SEND_BOOK = "forkluck.domains.recipes.actions.send_book_share"
NOTIFY_MANY = "forkluck.domains.recipes.actions.send_shares_notification"
SEND_LINK = "forkluck.domains.recipes.actions.send_guest_share"
NOTIFY_ONE = "forkluck.domains.recipes.actions.send_share_notification"


class RecipeBookTestCase(InternalApiTestCase):
    """One owner, two recipes, and the calls every test spells out."""

    @classmethod
    def setUpTestData(cls) -> None:
        cls.owner = User.objects.create_user(
            email="books-owner@example.com",
            password="a-long-test-passphrase-2468",
            name="Book Owner",
        )
        cls.first = Recipe.objects.create(
            user=cls.owner,
            title="Sourdough",
            code="B1",
            yield_amount=900.0,
            yield_unit="g",
        )
        cls.second = Recipe.objects.create(
            user=cls.owner,
            title="Focaccia",
            code="B2",
            yield_amount=600.0,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=cls.first,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Flour",
            quantity=500,
            unit="g",
        )

    def setUp(self) -> None:
        self.client.force_login(self.owner)

    def share_many(
        self,
        email: str,
        *,
        recipe_ids=None,
        role: str = RecipeShare.VIEWER,
        title=None,
        send=None,
    ):
        """Post one selection share with every mail stubbed.

        All four are patched, not only the book's: one id is delegated to
        `share-recipe`, which reaches for the single-recipe pair instead.
        The three the test is usually not about land on `self`, so the
        common unpack stays short.
        """
        body = {
            "recipeIds": (
                [str(self.first.id), str(self.second.id)]
                if recipe_ids is None
                else [str(value) for value in recipe_ids]
            ),
            "email": email,
            "role": role,
        }
        if title is not None:
            body["title"] = title
        with mock.patch(NOTIFY_ONE, mock.Mock()) as notified_one:
            with mock.patch(SEND_LINK, mock.Mock()) as sent_link:
                with mock.patch(NOTIFY_MANY, mock.Mock()) as notified:
                    with mock.patch(SEND_BOOK, send or mock.Mock()) as sent:
                        with self.captureOnCommitCallbacks(execute=True):
                            response = self.post_internal("share-recipes", body)
        self.notified = notified
        self.notified_one = notified_one
        self.sent_link = sent_link
        return response, sent

    def token_from(self, sent) -> str:
        return sent.call_args.kwargs["link"].rsplit("/", 1)[1]

    def mint(self, email: str = "cook@example.com", **kwargs) -> str:
        response, sent = self.share_many(email, **kwargs)
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
            f"/internal/v1/guest/books/{token}/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )


class ShareRecipesToAnAccountTests(RecipeBookTestCase):
    """A verified address needs no book: it gets the share rows themselves."""

    def test_a_verified_account_gets_one_share_per_recipe_and_one_mail(self):
        member = self.verified("member@example.com", "Member")
        response, sent = self.share_many("member@example.com")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"shared": 2, "guest": None})
        self.assertEqual(
            {
                share.recipe_id: share.role
                for share in RecipeShare.objects.filter(recipient=member)
            },
            {self.first.id: RecipeShare.VIEWER, self.second.id: RecipeShare.VIEWER},
        )
        self.assertFalse(RecipeBook.objects.exists())
        sent.assert_not_called()
        self.notified.assert_called_once()
        self.assertEqual(self.notified.call_args.args, ("member@example.com",))
        self.assertEqual(
            self.notified.call_args.kwargs,
            {
                "owner_name": "Book Owner",
                "recipe_count": 2,
                "role": RecipeShare.VIEWER,
                "link": f"{settings.FORKLUCK_APP_ORIGIN}/login?next=/recipes",
            },
        )

    def test_an_editor_selection_writes_editor_rows(self):
        member = self.verified("member@example.com", "Member")
        response, _ = self.share_many("member@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(response.json()["shared"], 2)
        self.assertEqual(
            {share.role for share in RecipeShare.objects.filter(recipient=member)},
            {RecipeShare.EDITOR},
        )
        self.assertEqual(self.notified.call_args.kwargs["role"], RecipeShare.EDITOR)

    def test_re_sharing_restates_the_role_rather_than_adding_rows(self):
        member = self.verified("member@example.com", "Member")
        self.share_many("member@example.com")
        self.share_many("member@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(RecipeShare.objects.filter(recipient=member).count(), 2)
        self.assertEqual(
            {share.role for share in RecipeShare.objects.filter(recipient=member)},
            {RecipeShare.EDITOR},
        )

    def test_the_owners_own_address_is_refused(self):
        User.objects.filter(id=self.owner.id).update(email_verified_at=timezone.now())
        response, _ = self.share_many(self.owner.email)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "You already own these recipes")
        self.assertFalse(RecipeShare.objects.exists())
        self.notified.assert_not_called()

    def test_a_failed_notification_leaves_the_shares_standing(self):
        member = self.verified("member@example.com", "Member")
        failing = mock.Mock(side_effect=EmailNotConfigured("no key"))
        with self.assertLogs("forkluck.domains.recipes.actions", "ERROR"):
            with mock.patch(NOTIFY_MANY, failing):
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.post_internal(
                        "share-recipes",
                        {
                            "recipeIds": [str(self.first.id), str(self.second.id)],
                            "email": "member@example.com",
                        },
                    )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(RecipeShare.objects.filter(recipient=member).count(), 2)


class ShareRecipesToAnUnknownAddressTests(RecipeBookTestCase):
    """No account means a book: one link over the whole selection."""

    def test_an_unknown_address_gets_one_book_in_send_order(self):
        response, sent = self.share_many(
            "cook@example.com", recipe_ids=[self.second.id, self.first.id]
        )
        self.assertEqual(response.status_code, 200)
        book = RecipeBook.objects.get()
        self.assertEqual(book.email, "cook@example.com")
        self.assertEqual(
            list(book.items.values_list("recipe_id", flat=True)),
            [self.second.id, self.first.id],
        )
        self.assertEqual(
            response.json(),
            {
                "shared": 0,
                "guest": {
                    "id": str(book.id),
                    "email": "cook@example.com",
                    "role": RecipeShare.VIEWER,
                    "title": "",
                },
            },
        )
        self.assertFalse(RecipeShare.objects.exists())
        sent.assert_called_once()
        token = self.token_from(sent)
        self.assertEqual(hash_guest_token(token), book.token_hash)
        self.assertEqual(
            sent.call_args.kwargs,
            {
                "owner_name": "Book Owner",
                "title": "",
                "recipe_count": 2,
                "link": f"{settings.FORKLUCK_APP_ORIGIN}/shared/book/{token}",
                "role": RecipeShare.VIEWER,
            },
        )

    def test_a_repeated_id_is_one_entry(self):
        self.share_many(
            "cook@example.com",
            recipe_ids=[self.first.id, self.second.id, self.first.id],
        )
        book = RecipeBook.objects.get()
        self.assertEqual(
            list(book.items.values_list("recipe_id", flat=True)),
            [self.first.id, self.second.id],
        )

    def test_sharing_the_same_address_again_writes_a_second_book(self):
        first_token = self.mint()
        second_token = self.mint()
        self.assertEqual(RecipeBook.objects.count(), 2)
        self.assertNotEqual(first_token, second_token)
        # A snapshot, not a rotation: the earlier link keeps working.
        self.assertEqual(self.guest_get(first_token).status_code, 200)
        self.assertEqual(self.guest_get(second_token).status_code, 200)

    def test_an_invited_editor_gets_an_editor_book(self):
        response, sent = self.share_many("cook@example.com", role=RecipeShare.EDITOR)
        self.assertEqual(RecipeBook.objects.get().role, RecipeShare.EDITOR)
        self.assertEqual(response.json()["guest"]["role"], RecipeShare.EDITOR)
        self.assertEqual(sent.call_args.kwargs["role"], RecipeShare.EDITOR)


class ShareRecipesDelegationTests(RecipeBookTestCase):
    """One id is a plain share, so nothing about it changes."""

    def test_one_unknown_address_id_mints_a_recipe_link_not_a_book(self):
        response, sent = self.share_many(
            "cook@example.com", recipe_ids=[self.first.id]
        )
        self.assertEqual(response.status_code, 200)
        sent.assert_not_called()
        self.sent_link.assert_called_once()
        self.assertFalse(RecipeBook.objects.exists())
        link = RecipeGuestLink.objects.get()
        self.assertEqual(
            response.json(),
            {
                "shared": 0,
                "guest": {
                    "id": str(link.id),
                    "email": "cook@example.com",
                    "role": RecipeShare.VIEWER,
                    "title": "",
                },
            },
        )

    def test_a_repeated_single_id_still_delegates(self):
        self.share_many(
            "cook@example.com", recipe_ids=[self.first.id, self.first.id]
        )
        self.assertFalse(RecipeBook.objects.exists())
        self.assertEqual(RecipeGuestLink.objects.count(), 1)

    def test_one_id_to_an_account_answers_one_share(self):
        member = self.verified("member@example.com", "Member")
        response, _ = self.share_many(
            "member@example.com", recipe_ids=[self.first.id]
        )
        self.assertEqual(response.json(), {"shared": 1, "guest": None})
        self.assertEqual(RecipeShare.objects.filter(recipient=member).count(), 1)
        self.notified_one.assert_called_once()
        self.notified.assert_not_called()


class ShareRecipesRefusalTests(RecipeBookTestCase):
    """What the action refuses, and that it refuses before writing anything."""

    def assertRefused(self, response, message: str) -> None:
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], message)
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeShare.objects.exists())
        self.assertFalse(RecipeGuestLink.objects.exists())

    def test_a_foreign_id_refuses_the_whole_request(self):
        stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-9753",
            name="Stranger",
        )
        theirs = Recipe.objects.create(user=stranger, title="Theirs", code="S1")
        response, sent = self.share_many(
            "cook@example.com", recipe_ids=[self.first.id, theirs.id]
        )
        self.assertRefused(response, "Recipe not found")
        sent.assert_not_called()

    def test_an_unknown_id_refuses_the_whole_request(self):
        response, sent = self.share_many(
            "cook@example.com", recipe_ids=[self.first.id, uuid.uuid4()]
        )
        self.assertRefused(response, "Recipe not found")
        sent.assert_not_called()

    def test_a_stranger_cannot_share_the_selection(self):
        stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-9753",
            name="Stranger",
        )
        client = Client()
        client.force_login(stranger)
        with mock.patch(SEND_BOOK) as sent:
            response = client.post(
                "/internal/v1/actions/share-recipes/",
                data=json.dumps(
                    {
                        "recipeIds": [str(self.first.id), str(self.second.id)],
                        "email": "cook@example.com",
                    }
                ),
                content_type="application/json",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
        self.assertRefused(response, "Recipe not found")
        sent.assert_not_called()

    def test_an_empty_selection_is_refused(self):
        response, _ = self.share_many("cook@example.com", recipe_ids=[])
        self.assertRefused(response, "Select between 1 and 50 recipes")

    def test_more_than_fifty_ids_are_refused(self):
        response, _ = self.share_many(
            "cook@example.com", recipe_ids=[uuid.uuid4() for _ in range(51)]
        )
        self.assertRefused(response, "Select between 1 and 50 recipes")

    def test_ids_that_are_not_a_list_are_refused(self):
        with mock.patch(SEND_BOOK):
            response = self.post_internal(
                "share-recipes",
                {"recipeIds": str(self.first.id), "email": "cook@example.com"},
            )
        self.assertRefused(response, "Select between 1 and 50 recipes")

    def test_a_junk_id_is_refused(self):
        response, _ = self.share_many("cook@example.com", recipe_ids=["not-a-uuid"])
        self.assertRefused(response, "Invalid recipe id")

    def test_an_invalid_role_is_refused(self):
        response, _ = self.share_many("cook@example.com", role="owner")
        self.assertRefused(response, "Invalid share role")

    def test_an_over_long_title_is_refused(self):
        response, _ = self.share_many("cook@example.com", title="x" * 121)
        self.assertRefused(response, "Title is too long")


class RecipeBookSendTests(RecipeBookTestCase):
    """The book exists only if its link left the building."""

    def test_a_failed_send_leaves_no_book_behind(self):
        response, _ = self.share_many(
            "cook@example.com",
            send=mock.Mock(side_effect=EmailNotConfigured("no key")),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "The invite email could not be sent"
        )
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeBookRecipe.objects.exists())

    def test_a_rejected_send_leaves_no_book_behind(self):
        response, _ = self.share_many(
            "cook@example.com", send=mock.Mock(side_effect=ValueError("rejected"))
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeBookRecipe.objects.exists())

    def test_the_daily_invite_limit_is_shared_with_single_recipe_links(self):
        for index in range(10):
            self.mint(f"cook{index}@example.com")
        for index in range(10, 20):
            with mock.patch(SEND_LINK):
                response = self.post_internal(
                    "share-recipe",
                    {
                        "recipeId": str(self.first.id),
                        "email": f"cook{index}@example.com",
                    },
                )
            self.assertEqual(response.status_code, 200)
        refused, _ = self.share_many("cook20@example.com")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            refused.json()["error"],
            "Too many guest invites today. Try again tomorrow.",
        )
        # And the other direction: a link is refused once books filled the day.
        with mock.patch(SEND_LINK):
            link_refused = self.post_internal(
                "share-recipe",
                {"recipeId": str(self.second.id), "email": "cook21@example.com"},
            )
        self.assertEqual(link_refused.status_code, 400)


class RecipeBookTitleTests(RecipeBookTestCase):
    """The owner's name for the book, or the one the reader is given."""

    def test_a_title_is_trimmed_and_carried_through(self):
        response, sent = self.share_many(
            "cook@example.com", title="  Bar program  "
        )
        self.assertEqual(RecipeBook.objects.get().title, "Bar program")
        self.assertEqual(response.json()["guest"]["title"], "Bar program")
        self.assertEqual(sent.call_args.kwargs["title"], "Bar program")
        payload = self.guest_get(self.token_from(sent)).json()["item"]
        self.assertEqual(payload["title"], "Bar program")

    def test_a_blank_title_is_stored_blank_and_defaults_for_the_reader(self):
        token = self.mint()
        self.assertEqual(RecipeBook.objects.get().title, "")
        self.assertEqual(
            self.guest_get(token).json()["item"]["title"],
            "2 recipes from Book Owner",
        )

    def test_a_whitespace_title_is_the_same_as_none(self):
        self.share_many("cook@example.com", title="   ")
        self.assertEqual(RecipeBook.objects.get().title, "")


class GuestBookReadTests(RecipeBookTestCase):
    """What the token serves, and when it serves nothing."""

    def test_the_book_serves_its_recipes_in_send_order(self):
        token = self.mint(recipe_ids=[self.second.id, self.first.id])
        item = self.guest_get(token).json()["item"]
        self.assertEqual(
            [recipe["title"] for recipe in item["recipes"]],
            ["Focaccia", "Sourdough"],
        )

    def test_the_payload_carries_the_book_and_nothing_private(self):
        response = self.guest_get(self.mint())
        item = response.json()["item"]
        self.assertEqual(set(item), {"title", "ownerName", "role", "recipes"})
        self.assertEqual(item["ownerName"], "Book Owner")
        self.assertEqual(
            set(item["recipes"][0]),
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
        dumped = json.dumps(response.json())
        for private in ("id", "foodCost", "menuPriceCents", "nutrition", "shares"):
            self.assertNotIn(private, dumped)

    def test_the_invited_role_rides_on_the_book_and_every_recipe(self):
        token = self.mint(role=RecipeShare.EDITOR)
        item = self.guest_get(token).json()["item"]
        self.assertEqual(item["role"], RecipeShare.EDITOR)
        self.assertEqual(
            {recipe["role"] for recipe in item["recipes"]}, {RecipeShare.EDITOR}
        )

    def test_a_junk_token_is_not_found(self):
        self.assertEqual(self.guest_get("not-a-real-token").status_code, 404)

    def test_an_over_long_token_is_not_found(self):
        self.assertEqual(self.guest_get("x" * 200).status_code, 404)

    def test_an_unknown_token_is_not_found(self):
        self.mint()
        self.assertEqual(self.guest_get(secrets.token_urlsafe(32)).status_code, 404)

    def test_a_single_recipe_token_is_not_a_book(self):
        with mock.patch(SEND_LINK) as sent:
            self.post_internal(
                "share-recipe",
                {"recipeId": str(self.first.id), "email": "cook@example.com"},
            )
        link_token = sent.call_args.kwargs["link"].rsplit("/", 1)[1]
        self.assertEqual(self.guest_get(link_token).status_code, 404)

    def test_an_archived_recipe_still_serves(self):
        token = self.mint()
        Recipe.objects.filter(id=self.first.id).update(status=Recipe.STATUS_ARCHIVED)
        self.assertEqual(self.guest_get(token).status_code, 200)

    def test_one_deleted_recipe_serves_the_rest(self):
        token = self.mint()
        Recipe.objects.filter(id=self.first.id).delete()
        item = self.guest_get(token).json()["item"]
        self.assertEqual([recipe["title"] for recipe in item["recipes"]], ["Focaccia"])
        # The default title counts what is left, not what was shared.
        self.assertEqual(item["title"], "1 recipe from Book Owner")

    def test_a_book_whose_recipes_are_all_gone_is_not_found(self):
        token = self.mint()
        Recipe.objects.filter(user=self.owner).delete()
        self.assertTrue(RecipeBook.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 404)

    def test_a_deleting_owner_stops_serving(self):
        token = self.mint()
        row = BillingAccount.objects.create(
            user=self.owner, status="deleting", locked=True
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


class RecipeBookRevokeTests(RecipeBookTestCase):
    """Deleting the row is the whole revocation."""

    def test_removing_the_book_kills_the_link(self):
        token = self.mint()
        book = RecipeBook.objects.get()
        response = self.post_internal("remove-recipe-book", {"bookId": str(book.id)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeBookRecipe.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 404)

    def test_a_stranger_cannot_revoke_the_book(self):
        token = self.mint()
        book = RecipeBook.objects.get()
        stranger = User.objects.create_user(
            email="stranger@example.com",
            password="a-long-test-passphrase-9753",
            name="Stranger",
        )
        client = Client()
        client.force_login(stranger)
        response = self.post_internal(
            "remove-recipe-book", {"bookId": str(book.id)}, client=client
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(RecipeBook.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 200)

    def test_a_junk_book_id_is_refused(self):
        response = self.post_internal("remove-recipe-book", {"bookId": "nope"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid book id")

    def test_deleting_a_recipe_leaves_the_book_serving_the_rest(self):
        token = self.mint()
        Recipe.objects.filter(id=self.second.id).delete()
        self.assertEqual(RecipeBookRecipe.objects.count(), 1)
        self.assertEqual(self.guest_get(token).status_code, 200)

    def test_reset_guest_links_counts_links_and_books(self):
        token = self.mint()
        with mock.patch(SEND_LINK) as sent:
            self.post_internal(
                "share-recipe",
                {"recipeId": str(self.first.id), "email": "other@example.com"},
            )
        link_token = sent.call_args.kwargs["link"].rsplit("/", 1)[1]
        response = self.post_internal("reset-guest-links", {})
        self.assertEqual(response.status_code, 200)
        # One link and one book, not the two book entries that went with it.
        self.assertEqual(response.json(), {"ok": True, "revoked": 2})
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeGuestLink.objects.exists())
        self.assertEqual(self.guest_get(token).status_code, 404)
        self.assertEqual(
            Client()
            .get(
                f"/internal/v1/guest/recipes/{link_token}/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
            .status_code,
            404,
        )


class RecipeBookOwnerViewTests(RecipeBookTestCase):
    """The book appears on every recipe inside it, for its owner only."""

    def detail(self, recipe: Recipe, *, client=None):
        return self.get_internal(
            f"recipes/{recipe.public_id}/", client=client
        ).json()["item"]

    def test_the_owner_sees_the_book_on_every_recipe_in_it(self):
        self.share_many("cook@example.com", title="Bar program")
        book = RecipeBook.objects.get()
        for recipe in (self.first, self.second):
            rows = self.detail(recipe)["bookLinks"]
            self.assertEqual(len(rows), 1)
            self.assertEqual(
                {key: rows[0][key] for key in ("id", "email", "role", "title")},
                {
                    "id": str(book.id),
                    "email": "cook@example.com",
                    "role": RecipeShare.VIEWER,
                    "title": "Bar program",
                },
            )
            self.assertEqual(rows[0]["recipeCount"], 2)
            self.assertIn("createdAt", rows[0])

    def test_a_recipe_outside_the_book_lists_none(self):
        third = Recipe.objects.create(user=self.owner, title="Baguette", code="B3")
        self.share_many("cook@example.com")
        self.assertEqual(self.detail(third)["bookLinks"], [])

    def test_two_books_over_one_recipe_are_both_listed(self):
        self.share_many("cook@example.com")
        self.share_many("other@example.com", recipe_ids=[self.first.id, self.second.id])
        self.assertEqual(
            {row["email"] for row in self.detail(self.first)["bookLinks"]},
            {"cook@example.com", "other@example.com"},
        )

    def test_a_collaborator_sees_no_book_links(self):
        self.share_many("cook@example.com")
        editor = self.verified("book-editor@example.com", "Editor")
        RecipeShare.objects.create(
            recipe=self.first, recipient=editor, role=RecipeShare.EDITOR
        )
        client = Client()
        client.force_login(editor)
        self.assertEqual(self.detail(self.first, client=client)["bookLinks"], [])
        self.assertEqual(len(self.detail(self.first)["bookLinks"]), 1)


class RecipeBookClaimTests(RecipeBookTestCase):
    """Verifying the address turns the book into the shares it promised."""

    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch("forkluck.verification.send_verification_code")
        self.send_code = patcher.start()
        self.addCleanup(patcher.stop)
        self.invitee = User.objects.create_user(
            email="cook@example.com",
            password="a-long-test-passphrase-1111",
            name="Cook",
        )
        self.own = Recipe.objects.create(
            user=self.invitee, title="Their own", code="B9"
        )
        self.book = self.make_book(
            [self.first, self.second, self.own], RecipeShare.VIEWER
        )

    def make_book(self, recipes, role: str) -> RecipeBook:
        # Minted directly: the action's throttle and mail are not the subject.
        book = RecipeBook.objects.create(
            user=self.owner,
            email="cook@example.com",
            token_hash=hash_guest_token(secrets.token_urlsafe(32)),
            role=role,
        )
        RecipeBookRecipe.objects.bulk_create(
            [
                RecipeBookRecipe(book=book, recipe=recipe, position=position)
                for position, recipe in enumerate(recipes)
            ]
        )
        return book

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
            share.recipe_id: share.role
            for share in RecipeShare.objects.filter(recipient=self.invitee)
        }

    def test_verifying_claims_the_book_and_skips_their_own_recipe(self):
        response = self.verify()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.roles(),
            {self.first.id: RecipeShare.VIEWER, self.second.id: RecipeShare.VIEWER},
        )
        self.assertFalse(RecipeBook.objects.exists())
        self.assertFalse(RecipeBookRecipe.objects.exists())

    def test_the_claim_counts_the_shares_it_wrote(self):
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 2)

    def test_claiming_twice_changes_nothing(self):
        self.verify()
        before = self.roles()
        self.invitee.refresh_from_db()
        self.assertEqual(claim_invitations(self.invitee), 0)
        self.assertEqual(self.roles(), before)

    def test_a_recipe_link_beats_the_book_it_also_sits_in(self):
        RecipeGuestLink.objects.create(
            recipe=self.first,
            email="cook@example.com",
            token_hash=hash_guest_token(secrets.token_urlsafe(32)),
            role=RecipeShare.EDITOR,
        )
        self.verify()
        # Books are claimed first, so the more specific grant lands last.
        self.assertEqual(self.roles()[self.first.id], RecipeShare.EDITOR)
        self.assertEqual(self.roles()[self.second.id], RecipeShare.VIEWER)

    def test_two_books_on_one_address_are_both_claimed(self):
        third = Recipe.objects.create(user=self.owner, title="Baguette", code="B4")
        self.make_book([third], RecipeShare.EDITOR)
        self.verify()
        self.assertEqual(self.roles()[third.id], RecipeShare.EDITOR)
        self.assertFalse(RecipeBook.objects.exists())
