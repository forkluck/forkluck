import secrets
import unicodedata
import uuid
from datetime import date as date_type, datetime
from decimal import Decimal
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.contrib.auth.base_user import BaseUserManager
from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q
from django.utils import timezone

from .units import measure_unit_choices, product_unit_choices, unit_family

# Defensive ceiling on units-per-sale so a typo cannot explode consumption.
MAX_VARIANT_MULTIPLIER = Decimal("1000000")
# DecimalField(max_digits=15, decimal_places=6) can store at most nine digits
# before the decimal point. Keep every measure ingestion path below that edge.
MAX_INGREDIENT_MEASURE_VALUE = Decimal("999999999.999999")
# A hydrating or cooking-up preparation can exceed 100%; ten times is not
# a yield, it is a typo.
MAX_PREPARATION_YIELD_PERCENT = Decimal("1000")

# Provider-owned tables and jobs must never accept the local manual ledger
# channel. Keep this separate from SalesImport.Channel, whose values also
# identify ledger rows and the hidden manual variant.
SALES_PROVIDER_CHOICES = (("square", "Square"), ("shopify", "Shopify"))


@lru_cache(maxsize=4096)
def normalized_name(value: str) -> str:
    """The one comparison key for a written name: accents fold away (NFKD,
    drop the Mark category — the shape both languages express exactly), then
    non-alphanumeric runs collapse to single spaces.

    `apps/web/lib/pricing.ts:normalizeIngredientName` is the TypeScript twin and must
    not drift. It lives here rather than in `domains.shared.values` (which
    re-exports it) because `save()` derives the stored key from it and
    import-linter forbids models from importing a domain.
    """
    folded = "".join(
        character
        for character in unicodedata.normalize("NFKD", value)
        if unicodedata.category(character)[0] != "M"
    )
    return " ".join(
        "".join(
            character.lower() if character.isalnum() else " " for character in folded
        ).split()
    )


def derive_normalized_name(instance, save_kwargs: dict) -> None:
    """Recompute the comparison key from `name` on the way into the database.

    A caller cannot set it, forget it, or set it with a different normalizer.
    A partial save that rewrites `name` has to rewrite the derived column with
    it, so the field is added to `update_fields` rather than silently dropped.
    """
    instance.normalized_name = normalized_name(instance.name)
    update_fields = save_kwargs.get("update_fields")
    if update_fields is not None and "name" in update_fields:
        save_kwargs["update_fields"] = [*update_fields, "normalized_name"]


# What a household measure can be written in, from the shared unit catalog.
IngredientMeasureUnit = measure_unit_choices


class InvoiceAiRead(models.Model):
    """One admitted AI read; independent of invoices so deletion cannot refund it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey("User", on_delete=models.CASCADE)
    period_start = models.DateField()
    pages = models.PositiveIntegerField()
    attempts = models.PositiveIntegerField(default=0)
    input_tokens = models.PositiveBigIntegerField(default=0)
    output_tokens = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=["user", "period_start"])]


class IngredientMeasureConfidence(models.TextChoices):
    HIGH = "high", "High"
    MEDIUM = "medium", "Medium"
    LOW = "low", "Low"


class UserManager(BaseUserManager["User"]):
    # Serialized into the initial migration as the User manager — do not rename.
    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email: str, password: str | None = None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if not extra_fields.get("is_staff") or not extra_fields.get("is_superuser"):
            raise ValueError("Superusers must have staff and superuser access")
        return self._create_user(email, password, **extra_fields)


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    username = None
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=150)
    # When set, the address was confirmed by Google or an emailed signup or
    # password-reset code. Development registration can grant a session without proof.
    email_verified_at = models.DateTimeField(null=True, blank=True)
    # New registrations (password or Google) notify on first verified sign-in.
    # Existing users and accounts created by admins never generate an owner alert.
    first_sign_in_notification_pending = models.BooleanField(default=False)
    google_subject = models.CharField(max_length=255, null=True, blank=True, unique=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    objects = UserManager()

    def __str__(self) -> str:
        return self.email


class FeedbackGrant(models.Model):
    """One short-lived, single-use authorization for our feedback board."""

    code_digest = models.CharField(max_length=64, primary_key=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    credential_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField(db_index=True)
    access_digest = models.CharField(max_length=64, unique=True, null=True)
    access_expires_at = models.DateTimeField(null=True)


class UUIDTimestampModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class PrimoConversation(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="primo_conversations"
    )
    title = models.CharField(max_length=200, blank=True, default="")
    is_archived = models.BooleanField(default=False)
    archived_at = models.DateTimeField(null=True, blank=True)
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "is_archived", "-last_message_at", "-id"])
        ]


class PrimoMessage(UUIDTimestampModel):
    conversation = models.ForeignKey(
        PrimoConversation, on_delete=models.CASCADE, related_name="messages"
    )
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    message_id = models.CharField(max_length=64)
    parent_message_id = models.CharField(max_length=64, blank=True, default="")
    feedback = models.CharField(max_length=8, blank=True, default="")
    feedback_comment = models.CharField(max_length=2000, blank=True, default="")
    role = models.CharField(max_length=16)
    parts = models.JSONField(default=list)
    text = models.TextField(blank=True, default="")
    status = models.CharField(max_length=16, default="complete")
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "message_id"],
                name="primo_message_unique",
            )
        ]
        indexes = [models.Index(fields=["conversation", "created_at", "id"])]


class PrimoAttachment(UUIDTimestampModel):
    # Keep cleanup records after account/message deletion until blob removal succeeds.
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    conversation_id = models.UUIDField()
    message = models.ForeignKey(PrimoMessage, null=True, on_delete=models.SET_NULL)
    document_key = models.CharField(max_length=150, unique=True)
    name = models.CharField(max_length=255)
    media_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    content = models.TextField(blank=True)
    coverage = models.CharField(max_length=255, blank=True)
    expires_at = models.DateTimeField()
    deleted = models.BooleanField(default=False)


class EmailVerificationCode(UUIDTimestampModel):
    """A short-lived 6-digit code emailed to prove address ownership.

    Codes are stored hashed (sha256 over code + SECRET_KEY) and are
    single-use: verification marks `used_at`, and each wrong guess bumps
    `attempts` until the code burns out. Issuance is rate-limited per
    address in the verification module, not here.
    """

    PURPOSE_SIGNUP = "signup"
    PURPOSE_ADMIN = "admin"
    PURPOSE_PASSWORD_RESET = "password_reset"
    PURPOSE_CHOICES = [
        (PURPOSE_SIGNUP, "Signup"),
        (PURPOSE_ADMIN, "Admin sign-in"),
        (PURPOSE_PASSWORD_RESET, "Password reset"),
    ]

    MAX_ATTEMPTS = 6

    email = models.EmailField()
    purpose = models.CharField(max_length=16, choices=PURPOSE_CHOICES)
    code_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    attempts = models.IntegerField(default=0)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["email", "purpose", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.purpose} code for {self.email}"


class AuthThrottle(models.Model):
    """A fixed-window counter for authentication and credential endpoints.

    The authenticated rate limiter (MasterPriceAccess) counts rows under the
    workspace's own row lock, which needs a User to lock. Sign-in, code
    issuance and password reset all run before any user is established — and
    for addresses that may not exist at all — so they count here instead,
    keyed by whatever identity is available. Password change supplies the user
    id for its account bucket and uses the same table for its client IP.

    One row per (scope, key), updated under SELECT ... FOR UPDATE, so the
    check and the increment cannot interleave the way count-then-insert could.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope = models.CharField(max_length=32)
    key = models.CharField(max_length=200)
    count = models.IntegerField(default=0)
    window_start = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "key"], name="auth_throttle_scope_key_unique"
            )
        ]
        indexes = [models.Index(fields=["window_start"])]

    def __str__(self) -> str:
        return f"{self.scope}:{self.key} ({self.count})"


# Crockford-style base32: no i/l/o/u, so ids are unambiguous when read aloud.
PUBLIC_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def generate_public_id(prefix: str, length: int = 12) -> str:
    body = "".join(secrets.choice(PUBLIC_ID_ALPHABET) for _ in range(length))
    return f"{prefix}_{body}"


# Serialized into the initial migration as a field default — do not rename.
def generate_recipe_public_id() -> str:
    return generate_public_id("rcp")


# Serialized into the initial migration as a field default — do not rename.
def generate_ingredient_public_id() -> str:
    return generate_public_id("ing")


def generate_sales_product_public_id() -> str:
    return generate_public_id("prd")


def derive_public_id_from_uuid(prefix: str, value: uuid.UUID, length: int = 12) -> str:
    """Deterministic variant used by backfills and demo seeds: the top bits of
    an existing UUID re-encoded in the public-id alphabet, so reruns are
    stable and match the migration backfill."""
    n = value.int >> (128 - 5 * length)
    chars = []
    for _ in range(length):
        chars.append(PUBLIC_ID_ALPHABET[n & 31])
        n >>= 5
    return f"{prefix}_{''.join(reversed(chars))}"


class RecipeCategory(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_categories"
    )
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=64)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="recipe_category_user_normalized_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


class Recipe(UUIDTimestampModel):
    KIND_RECIPE = "recipe"
    KIND_COMPONENT = "component"
    KIND_CHOICES = [
        (KIND_RECIPE, "Recipe"),
        (KIND_COMPONENT, "Component"),
    ]

    STATUS_ACTIVE = "active"
    STATUS_ARCHIVED = "archived"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_ARCHIVED, "Archived"),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="recipes")
    edit_version = models.PositiveIntegerField(default=0)
    title = models.CharField(max_length=200)
    # Globally unique, opaque, Stripe-style id used in URLs. Unlike `code`
    # (per-user, sequential) it never collides across users and leaks nothing.
    public_id = models.CharField(
        max_length=24, unique=True, default=generate_recipe_public_id
    )
    code = models.CharField(max_length=32, blank=True, default="")
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default=KIND_RECIPE)
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=STATUS_ACTIVE
    )
    # A costed recipe someone is cooking from, held against stray edits. It is
    # a guard, not a permission: the owner flips it back whenever they mean to.
    locked = models.BooleanField(default=False)
    category = models.ForeignKey(
        RecipeCategory,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="recipes",
    )
    description = models.TextField(blank=True, default="")
    # Legacy import/export compatibility only. Normalized RecipeItem and
    # RecipeStep rows are authoritative for editing and costing.
    body = models.TextField(blank=True)
    method = models.TextField(blank=True, default="")
    yield_amount = models.FloatField(null=True, blank=True)
    yield_unit = models.CharField(max_length=8, null=True, blank=True)
    sellable_yield = models.FloatField(null=True, blank=True)
    menu_price_cents = models.IntegerField(null=True, blank=True)
    serving_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    serving_unit = models.CharField(max_length=64, blank=True, default="")
    # The serving a label preview describes. Separate from `serving_*`, which
    # is the portion cost per serving divides by.
    nutrition_serving_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    nutrition_serving_unit = models.CharField(max_length=64, blank=True, default="")
    # The retail package a label preview describes. Unset means the batch is
    # the container.
    nutrition_package_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    nutrition_package_unit = models.CharField(max_length=64, blank=True, default="")
    shelf_life_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    shelf_life_unit = models.CharField(max_length=64, blank=True, default="")
    prep_time_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    prep_time_unit = models.CharField(max_length=16, blank=True, default="")
    auto_sum_yield_enabled = models.BooleanField(default=False)
    auto_prep_time_enabled = models.BooleanField(default=False)
    percentage_mode = models.CharField(max_length=16, blank=True, default="")
    percent_ingredient_enabled = models.BooleanField(default=False)
    percent_ingredient_type = models.CharField(max_length=16, blank=True, default="")

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["user", "-updated_at"]),
            models.Index(fields=["user", "status"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "code"],
                condition=~Q(code=""),
                name="recipe_user_code_unique",
            ),
            models.CheckConstraint(
                condition=Q(serving_amount__isnull=True) | Q(serving_amount__gt=0),
                name="recipe_serving_amount_positive",
            ),
            models.CheckConstraint(
                condition=Q(shelf_life_amount__isnull=True)
                | Q(shelf_life_amount__gt=0),
                name="recipe_shelf_life_amount_positive",
            ),
            models.CheckConstraint(
                condition=Q(serving_amount__isnull=True) | ~Q(serving_unit=""),
                name="recipe_serving_pair",
            ),
            models.CheckConstraint(
                condition=Q(nutrition_serving_amount__isnull=True)
                | Q(nutrition_serving_amount__gt=0),
                name="recipe_nutrition_serving_amount_positive",
            ),
            models.CheckConstraint(
                condition=Q(nutrition_serving_amount__isnull=True)
                | ~Q(nutrition_serving_unit=""),
                name="recipe_nutrition_serving_pair",
            ),
            models.CheckConstraint(
                condition=Q(nutrition_package_amount__isnull=True)
                | Q(nutrition_package_amount__gt=0),
                name="recipe_nutrition_package_amount_positive",
            ),
            models.CheckConstraint(
                condition=Q(nutrition_package_amount__isnull=True)
                | ~Q(nutrition_package_unit=""),
                name="recipe_nutrition_package_pair",
            ),
            models.CheckConstraint(
                condition=Q(shelf_life_amount__isnull=True) | ~Q(shelf_life_unit=""),
                name="recipe_shelf_life_pair",
            ),
            models.CheckConstraint(
                condition=Q(prep_time_amount__isnull=True) | Q(prep_time_amount__gt=0),
                name="recipe_prep_time_amount_positive",
            ),
            models.CheckConstraint(
                condition=Q(prep_time_amount__isnull=True) | ~Q(prep_time_unit=""),
                name="recipe_prep_time_pair",
            ),
        ]

    def clean(self):
        super().clean()
        if (self.serving_amount is None) != (not self.serving_unit):
            raise ValidationError("Serving amount and unit must be supplied together")
        if (self.nutrition_serving_amount is None) != (not self.nutrition_serving_unit):
            raise ValidationError(
                "Nutrition serving amount and unit must be supplied together"
            )
        if (self.nutrition_package_amount is None) != (not self.nutrition_package_unit):
            raise ValidationError(
                "Nutrition package amount and unit must be supplied together"
            )
        if (self.shelf_life_amount is None) != (not self.shelf_life_unit):
            raise ValidationError(
                "Shelf-life amount and unit must be supplied together"
            )
        if (self.prep_time_amount is None) != (not self.prep_time_unit):
            raise ValidationError("Prep-time amount and unit must be supplied together")

    def __str__(self) -> str:
        return self.title


class RecipeItem(UUIDTimestampModel):
    """One ordered, normalized row in a recipe's ingredient block.

    ``display_name`` survives an unlinked component target. A linked pantry
    ingredient is restricted from deletion so its saved identity cannot be
    silently orphaned.
    """

    HEADER = "header"
    NOTE = "note"
    INGREDIENT = "ingredient"
    SUBRECIPE = "subrecipe"
    KIND_CHOICES = [
        (HEADER, "Header"),
        (NOTE, "Note"),
        (INGREDIENT, "Ingredient"),
        (SUBRECIPE, "Subrecipe"),
    ]

    recipe = models.ForeignKey(Recipe, on_delete=models.CASCADE, related_name="items")
    kind = models.CharField(max_length=12, choices=KIND_CHOICES)
    position = models.PositiveIntegerField(default=0)
    display_name = models.CharField(max_length=200, blank=True, default="")
    quantity = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    unit = models.CharField(max_length=64, blank=True, default="")
    preparation_note = models.CharField(max_length=200, blank=True, default="")
    efficiency = models.DecimalField(max_digits=7, decimal_places=3, default=100)
    # Yield after cooking: the share of this line that remains in the dish,
    # 0..100. Searing oil keeps 2, a discarded brine keeps 0. Nutrition reads
    # it; costing does not, because what is bought does not change.
    efficiency_after_cooking = models.DecimalField(
        max_digits=7, decimal_places=3, default=100
    )
    # Baker's percentages are stated against one line — the flour, usually.
    is_base = models.BooleanField(default=False)
    # Money only: weight and nutrition still count the line.
    excluded_from_cost = models.BooleanField(default=False)
    ingredient = models.ForeignKey(
        "Ingredient",
        on_delete=models.RESTRICT,
        null=True,
        blank=True,
        related_name="recipe_items",
    )
    subrecipe = models.ForeignKey(
        Recipe,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="parent_items",
    )

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["recipe", "position"])]
        constraints = [
            models.UniqueConstraint(
                fields=["recipe", "position"], name="recipe_item_position_unique"
            ),
            models.CheckConstraint(
                condition=Q(quantity__gt=0) | Q(quantity__isnull=True),
                name="recipe_item_quantity_positive",
            ),
            models.CheckConstraint(
                condition=Q(efficiency__gt=0)
                & Q(efficiency_after_cooking__gte=0)
                & Q(efficiency_after_cooking__lte=100),
                name="recipe_item_efficiency_bounded",
            ),
            models.CheckConstraint(
                condition=(
                    (
                        Q(kind__in=["header", "note"])
                        & Q(ingredient__isnull=True)
                        & Q(subrecipe__isnull=True)
                    )
                    | (Q(kind="ingredient") & Q(subrecipe__isnull=True))
                    | (Q(kind="subrecipe") & Q(ingredient__isnull=True))
                ),
                name="recipe_item_target_matches_kind",
            ),
            models.CheckConstraint(
                condition=~(
                    Q(kind__in=["header", "note"])
                    & (~Q(unit="") | Q(quantity__isnull=False))
                ),
                name="recipe_item_header_note_plain",
            ),
        ]

    def clean(self):
        super().clean()
        if self.kind in {self.HEADER, self.NOTE}:
            if (
                self.quantity is not None
                or self.unit
                or self.ingredient_id
                or self.subrecipe_id
            ):
                raise ValidationError(
                    "Headers and notes cannot carry quantity or targets"
                )
        elif self.kind == self.INGREDIENT and self.subrecipe_id:
            raise ValidationError("Ingredient rows cannot target a subrecipe")
        elif self.kind == self.SUBRECIPE and self.ingredient_id:
            raise ValidationError("Subrecipe rows cannot target an ingredient")
        if self.quantity is not None and self.quantity <= 0:
            raise ValidationError("Recipe item quantity must be positive")
        if self.efficiency is not None and self.efficiency <= 0:
            raise ValidationError("Recipe item efficiency must be positive")
        if self.efficiency_after_cooking is not None and not (
            0 <= self.efficiency_after_cooking <= 100
        ):
            raise ValidationError("Yield after cooking must be between 0 and 100")
        if self.ingredient_id and self.ingredient.user_id != self.recipe.user_id:
            raise ValidationError("Ingredient belongs to another workspace")
        if self.subrecipe_id:
            if self.subrecipe.user_id != self.recipe.user_id:
                raise ValidationError("Subrecipe belongs to another workspace")
            if self.subrecipe_id == self.recipe_id:
                raise ValidationError("A recipe cannot contain itself")

            # Walk the current graph before accepting this edge.  This is kept
            # in model validation so every admin/import/action path gets the
            # same cycle guard.
            def reaches(start_id, path: set):
                if start_id in path:
                    raise ValidationError("Recipe subrecipes cannot contain a cycle")
                next_path = path | {start_id}
                for child_id in RecipeItem.objects.filter(
                    recipe_id=start_id, kind=self.SUBRECIPE, subrecipe__isnull=False
                ).values_list("subrecipe_id", flat=True):
                    reaches(child_id, next_path)

            reaches(self.subrecipe_id, {self.recipe_id})


class RecipeStep(UUIDTimestampModel):
    """Ordered preparation prose and optional labour metadata."""

    INSTRUCTION = "instruction"
    HEADER = "header"
    NOTE = "note"
    KIND_CHOICES = [(INSTRUCTION, "Instruction"), (HEADER, "Header"), (NOTE, "Note")]
    LABOR_KINDS = {"", "active", "passive"}

    recipe = models.ForeignKey(Recipe, on_delete=models.CASCADE, related_name="steps")
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default=INSTRUCTION)
    title = models.CharField(max_length=200, blank=True, default="")
    body = models.TextField(blank=True, default="")
    position = models.PositiveIntegerField(default=0)
    labor_kind = models.CharField(max_length=16, blank=True, default="")

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["recipe", "position"], name="recipe_step_position_unique"
            ),
        ]

    def clean(self):
        super().clean()
        if self.labor_kind not in self.LABOR_KINDS:
            raise ValidationError("Invalid labor kind")


class RecipeTiming(UUIDTimestampModel):
    step = models.ForeignKey(
        RecipeStep, on_delete=models.CASCADE, related_name="timings"
    )
    seconds = models.PositiveIntegerField()
    yield_count = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(seconds__gt=0), name="recipe_timing_seconds_positive"
            ),
            models.CheckConstraint(
                condition=Q(yield_count__gt=0), name="recipe_timing_yield_positive"
            ),
        ]


class RecipeBatchSize(UUIDTimestampModel):
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="batch_sizes"
    )
    label = models.CharField(max_length=120, blank=True, default="")
    scale = models.DecimalField(max_digits=15, decimal_places=6)
    is_original = models.BooleanField(default=False)

    class Meta:
        ordering = ["-is_original", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(scale__gt=0), name="recipe_batch_size_scale_positive"
            ),
            models.UniqueConstraint(
                fields=["recipe", "label"], name="recipe_batch_size_label_unique"
            ),
            models.UniqueConstraint(
                fields=["recipe"],
                condition=Q(is_original=True),
                name="recipe_batch_size_one_original",
            ),
        ]

    def clean(self):
        super().clean()
        if (
            self.is_original
            and RecipeBatchSize.objects.filter(
                recipe_id=self.recipe_id, is_original=True
            )
            .exclude(pk=self.pk)
            .exists()
        ):
            raise ValidationError("A recipe can have only one original batch size")


class RecipeEquivalency(UUIDTimestampModel):
    recipe = models.OneToOneField(
        Recipe, on_delete=models.CASCADE, related_name="equivalency"
    )
    mass_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    mass_unit = models.CharField(max_length=64, blank=True, default="")
    volume_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    volume_unit = models.CharField(max_length=64, blank=True, default="")
    count_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    count_unit = models.CharField(max_length=64, blank=True, default="")
    standard = models.BooleanField(default=True)

    class Meta:
        verbose_name_plural = "recipe equivalencies"

    def clean(self):
        super().clean()
        for amount, unit, label in (
            (self.mass_amount, self.mass_unit, "mass"),
            (self.volume_amount, self.volume_unit, "volume"),
            (self.count_amount, self.count_unit, "count"),
        ):
            if (amount is None) != (not unit):
                raise ValidationError(
                    f"{label} amount and unit must be supplied together"
                )
            if amount is not None and amount <= 0:
                raise ValidationError(f"{label} amount must be positive")
            if unit and unit_family(unit) != label:
                raise ValidationError(f"{label} unit must be a {label} unit")


class RecipeTag(UUIDTimestampModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="recipe_tags")
    name = models.CharField(max_length=80)
    normalized_name = models.CharField(max_length=80)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="recipe_tag_user_normalized_unique",
            )
        ]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)


class RecipeTagMembership(models.Model):
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="tag_memberships"
    )
    tag = models.ForeignKey(
        RecipeTag, on_delete=models.CASCADE, related_name="memberships"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["recipe", "tag"], name="recipe_tag_membership_unique"
            )
        ]

    def clean(self):
        super().clean()
        if self.recipe_id and self.tag_id and self.recipe.user_id != self.tag.user_id:
            raise ValidationError("Recipe tag belongs to another workspace")


class RecipeShare(UUIDTimestampModel):
    VIEWER = "viewer"
    EDITOR = "editor"
    ROLE_CHOICES = [(VIEWER, "Viewer"), (EDITOR, "Editor")]
    recipe = models.ForeignKey(Recipe, on_delete=models.CASCADE, related_name="shares")
    recipient = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_shares"
    )
    role = models.CharField(max_length=8, choices=ROLE_CHOICES, default=VIEWER)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["recipe", "recipient"], name="recipe_share_unique"
            )
        ]

    def clean(self):
        super().clean()
        if (
            self.recipe_id
            and self.recipient_id
            and self.recipe.user_id == self.recipient_id
        ):
            raise ValidationError("A recipe cannot be shared with its owner")


class RecipeGuestLink(UUIDTimestampModel):
    """A capability URL for one email address that has no account.

    The token itself is the authorization, so only its hash is stored.
    Revoking is deleting the row; re-sharing the same address rotates it.
    The role is what the address gets once it verifies: verification turns
    the link into a share row carrying this role.
    """

    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="guest_links"
    )
    email = models.EmailField(max_length=320)
    token_hash = models.CharField(max_length=64, unique=True)
    role = models.CharField(
        max_length=8,
        choices=RecipeShare.ROLE_CHOICES,
        default=RecipeShare.VIEWER,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["recipe", "email"], name="recipe_guest_link_unique"
            )
        ]


class RecipeBook(UUIDTimestampModel):
    """One capability URL over several recipes, for an address with no account.

    A book is a snapshot of the selection that was shared, not a living
    collection: the recipes inside stay live, adding one later means sharing
    again, and re-sharing the same address makes a second book rather than
    rotating the first. Like a guest link, only the token's hash is stored,
    revoking is deleting the row, and verification turns the book into one
    share row per recipe at this role.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_books"
    )
    email = models.EmailField(max_length=320)
    # Blank means the reader is shown the default, "N recipes from <owner>".
    title = models.CharField(max_length=120, blank=True, default="")
    token_hash = models.CharField(max_length=64, unique=True)
    role = models.CharField(
        max_length=8,
        choices=RecipeShare.ROLE_CHOICES,
        default=RecipeShare.VIEWER,
    )


class RecipeBookRecipe(UUIDTimestampModel):
    """One recipe's place in a book, in the order the owner shared them."""

    book = models.ForeignKey(RecipeBook, on_delete=models.CASCADE, related_name="items")
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="book_items"
    )
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["book", "recipe"], name="recipe_book_recipe_unique"
            )
        ]


class KitchenMembership(UUIDTimestampModel):
    """One row lets `member` open every recipe `owner` has, at this role.

    A share is per recipe; a membership is the whole recipe book, and it is
    the only collaboration that survives the owner adding a recipe. It grants
    nothing else: money, invoices, sales, labor and settings stay owner-only
    because every one of those reads is scoped to `request.user`, who is the
    member's own empty tenant.
    """

    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="members")
    member = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="kitchen_memberships"
    )
    role = models.CharField(
        max_length=8,
        choices=RecipeShare.ROLE_CHOICES,
        default=RecipeShare.VIEWER,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "member"], name="kitchen_membership_unique"
            ),
            models.CheckConstraint(
                condition=~Q(owner=F("member")), name="kitchen_membership_not_self"
            ),
        ]


class KitchenInvite(UUIDTimestampModel):
    """A kitchen promised to an address that has no account yet.

    No token and no expiry: a member has to be an account holder, so the
    invite is claimed by address at verification and turns into the
    membership row it always described.
    """

    owner = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="kitchen_invites"
    )
    email = models.EmailField(max_length=320)
    role = models.CharField(
        max_length=8,
        choices=RecipeShare.ROLE_CHOICES,
        default=RecipeShare.VIEWER,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "email"], name="kitchen_invite_unique"
            )
        ]


class RecipeComment(UUIDTimestampModel):
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="comments"
    )
    author = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_comments"
    )
    body = models.TextField()


class RecipeMedia(UUIDTimestampModel):
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, null=True, blank=True, related_name="media"
    )
    step = models.ForeignKey(
        RecipeStep,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="media",
    )
    url = models.URLField(max_length=2000)
    thumbnail_url = models.URLField(max_length=2000, blank=True, default="")
    mobile_url = models.URLField(max_length=2000, blank=True, default="")
    alt_text = models.CharField(max_length=240, blank=True, default="")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name_plural = "recipe media"
        ordering = ["position", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(Q(recipe__isnull=True) ^ Q(step__isnull=True)),
                name="recipe_media_exactly_one_parent",
            )
        ]

    def clean(self):
        super().clean()
        if (self.recipe_id is None) == (self.step_id is None):
            raise ValidationError("Media must belong to exactly one recipe or step")
        if self.step_id and self.recipe_id and self.step.recipe_id != self.recipe_id:
            raise ValidationError("Media step must belong to the same recipe")


class CatalogSource(UUIDTimestampModel):
    """Private provenance for a supplier-neutral Forkluck catalog source."""

    key = models.CharField(max_length=64, unique=True)
    private_label = models.CharField(max_length=120, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["key"]

    def __str__(self) -> str:
        return self.key


class CatalogImportBatch(UUIDTimestampModel):
    source = models.ForeignKey(
        CatalogSource, on_delete=models.PROTECT, related_name="import_batches"
    )
    content_sha256 = models.CharField(max_length=64)
    file_name = models.CharField(max_length=255, blank=True, default="")
    observed_at = models.DateTimeField()
    row_count = models.PositiveIntegerField(default=0)
    imported_count = models.PositiveIntegerField(default=0)
    review_count = models.PositiveIntegerField(default=0)
    discarded_count = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name_plural = "catalog import batches"
        ordering = ["-observed_at", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "content_sha256"],
                name="catalog_batch_source_sha_unique",
            )
        ]


class CatalogIngredient(UUIDTimestampModel):
    """A single approved, supplier-neutral ingredient shown in Catalog."""

    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120, unique=True)
    # The stable slug from the open catalog file. Renaming an entry keeps its
    # key, so pantry rows linked to it never orphan.
    key = models.CharField(max_length=64, unique=True, null=True, blank=True)
    category = models.CharField(max_length=64, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["normalized_name"])]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.name


class CatalogIngredientMeasure(UUIDTimestampModel):
    """A reviewed shared household measure for one canonical ingredient."""

    ingredient = models.ForeignKey(
        CatalogIngredient, on_delete=models.CASCADE, related_name="measures"
    )
    unit = models.CharField(max_length=32, choices=IngredientMeasureUnit)
    amount = models.DecimalField(max_digits=15, decimal_places=6)
    grams = models.DecimalField(max_digits=15, decimal_places=6)
    low_grams = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    high_grams = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    qualifier = models.CharField(max_length=120, blank=True, default="")
    source_kind = models.CharField(max_length=32)
    source_ref = models.CharField(max_length=120)
    confidence = models.CharField(
        max_length=8,
        choices=IngredientMeasureConfidence.choices,
        default=IngredientMeasureConfidence.MEDIUM,
    )
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["ingredient__name", "unit", "qualifier", "source_kind"]
        indexes = [models.Index(fields=["ingredient", "unit", "qualifier"])]
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "ingredient",
                    "unit",
                    "qualifier",
                    "source_kind",
                    "source_ref",
                ],
                name="catalog_measure_source_unique",
            ),
            models.UniqueConstraint(
                fields=["ingredient", "unit", "qualifier"],
                condition=Q(is_default=True),
                name="catalog_measure_one_default",
            ),
            models.CheckConstraint(
                condition=Q(amount__gt=0), name="catalog_measure_amount_positive"
            ),
            models.CheckConstraint(
                condition=Q(grams__gt=0), name="catalog_measure_grams_positive"
            ),
            models.CheckConstraint(
                condition=Q(low_grams__isnull=True) | Q(low_grams__gt=0),
                name="catalog_measure_low_positive",
            ),
            models.CheckConstraint(
                condition=Q(high_grams__isnull=True) | Q(high_grams__gt=0),
                name="catalog_measure_high_positive",
            ),
            models.CheckConstraint(
                condition=(
                    Q(low_grams__isnull=True)
                    | Q(high_grams__isnull=True)
                    | Q(low_grams__lte=models.F("high_grams"))
                ),
                name="catalog_measure_range_ordered",
            ),
            models.CheckConstraint(
                condition=Q(low_grams__isnull=True)
                | Q(low_grams__lte=models.F("grams")),
                name="catalog_measure_grams_above_low",
            ),
            models.CheckConstraint(
                condition=Q(high_grams__isnull=True)
                | Q(high_grams__gte=models.F("grams")),
                name="catalog_measure_grams_below_high",
            ),
            models.CheckConstraint(
                condition=(
                    Q(low_grams__isnull=True, high_grams__isnull=True)
                    | Q(low_grams__isnull=False, high_grams__isnull=False)
                ),
                name="catalog_measure_range_paired",
            ),
            models.CheckConstraint(
                condition=Q(is_default=False) | Q(is_active=True),
                name="catalog_measure_default_active",
            ),
        ]


class CatalogPreparationMeasure(UUIDTimestampModel):
    """A reviewed household measure for one preparation yield.

    Preparation measures deliberately point at the yield row instead of the
    base ingredient: a cup of chopped herbs and a cup of whole herbs can have
    different mass estimates.
    """

    preparation_yield = models.ForeignKey(
        "CatalogPreparationYield",
        on_delete=models.CASCADE,
        related_name="measures",
    )
    unit = models.CharField(max_length=32, choices=IngredientMeasureUnit)
    amount = models.DecimalField(max_digits=15, decimal_places=6)
    grams = models.DecimalField(max_digits=15, decimal_places=6)
    qualifier = models.CharField(max_length=120, blank=True, default="")
    source_kind = models.CharField(max_length=32)
    source_ref = models.CharField(max_length=120)
    confidence = models.CharField(
        max_length=8,
        choices=IngredientMeasureConfidence.choices,
        default=IngredientMeasureConfidence.MEDIUM,
    )
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["preparation_yield__normalized_name", "unit", "qualifier"]
        indexes = [models.Index(fields=["preparation_yield", "unit", "qualifier"])]
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "preparation_yield",
                    "unit",
                    "qualifier",
                    "source_kind",
                    "source_ref",
                ],
                name="catalog_prep_measure_source_unique",
            ),
            models.UniqueConstraint(
                fields=["preparation_yield", "unit", "qualifier"],
                condition=Q(is_default=True),
                name="catalog_prep_measure_one_default",
            ),
            models.CheckConstraint(
                condition=Q(amount__gt=0), name="catalog_prep_measure_amount_positive"
            ),
            models.CheckConstraint(
                condition=Q(grams__gt=0), name="catalog_prep_measure_grams_positive"
            ),
            models.CheckConstraint(
                condition=Q(is_default=False) | Q(is_active=True),
                name="catalog_prep_measure_default_active",
            ),
        ]


class CatalogPreparationYield(UUIDTimestampModel):
    """A reviewed shared yield for one preparation of a canonical ingredient.

    Kept apart from `CatalogIngredientMeasure`: a trimming or cooking loss is
    not a cup-to-gram record and the two must never be combined.
    """

    ingredient = models.ForeignKey(
        CatalogIngredient, on_delete=models.CASCADE, related_name="preparation_yields"
    )
    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120)
    yield_percent = models.DecimalField(max_digits=7, decimal_places=3)
    low_percent = models.DecimalField(
        max_digits=7, decimal_places=3, null=True, blank=True
    )
    high_percent = models.DecimalField(
        max_digits=7, decimal_places=3, null=True, blank=True
    )
    source_kind = models.CharField(max_length=32)
    source_ref = models.CharField(max_length=120)
    source_release = models.CharField(max_length=120)
    derivation = models.CharField(max_length=32)
    evidence_count = models.PositiveIntegerField()
    confidence = models.CharField(
        max_length=8,
        choices=IngredientMeasureConfidence.choices,
        default=IngredientMeasureConfidence.MEDIUM,
    )
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["ingredient__name", "normalized_name", "source_kind"]
        indexes = [models.Index(fields=["ingredient", "normalized_name"])]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "normalized_name", "source_kind", "source_ref"],
                name="catalog_prep_yield_source_unique",
            ),
            models.UniqueConstraint(
                fields=["ingredient", "normalized_name"],
                condition=Q(is_default=True),
                name="catalog_prep_yield_one_default",
            ),
            models.CheckConstraint(
                condition=Q(
                    yield_percent__gt=0,
                    yield_percent__lte=MAX_PREPARATION_YIELD_PERCENT,
                ),
                name="catalog_prep_yield_percent_bounded",
            ),
            models.CheckConstraint(
                condition=Q(low_percent__isnull=True)
                | Q(low_percent__gt=0, low_percent__lte=MAX_PREPARATION_YIELD_PERCENT),
                name="catalog_prep_yield_low_bounded",
            ),
            models.CheckConstraint(
                condition=Q(high_percent__isnull=True)
                | Q(
                    high_percent__gt=0,
                    high_percent__lte=MAX_PREPARATION_YIELD_PERCENT,
                ),
                name="catalog_prep_yield_high_bounded",
            ),
            models.CheckConstraint(
                condition=(
                    Q(low_percent__isnull=True)
                    | Q(high_percent__isnull=True)
                    | Q(low_percent__lte=models.F("high_percent"))
                ),
                name="catalog_prep_yield_range_ordered",
            ),
            models.CheckConstraint(
                condition=Q(low_percent__isnull=True)
                | Q(low_percent__lte=models.F("yield_percent")),
                name="catalog_prep_yield_above_low",
            ),
            models.CheckConstraint(
                condition=Q(high_percent__isnull=True)
                | Q(high_percent__gte=models.F("yield_percent")),
                name="catalog_prep_yield_below_high",
            ),
            models.CheckConstraint(
                condition=(
                    Q(low_percent__isnull=True, high_percent__isnull=True)
                    | Q(low_percent__isnull=False, high_percent__isnull=False)
                ),
                name="catalog_prep_yield_range_paired",
            ),
            models.CheckConstraint(
                condition=Q(evidence_count__gt=0),
                name="catalog_prep_yield_evidence_positive",
            ),
            models.CheckConstraint(
                condition=Q(is_default=False) | Q(is_active=True),
                name="catalog_prep_yield_default_active",
            ),
        ]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.ingredient.name}: {self.name}"


class CatalogProduct(UUIDTimestampModel):
    class PriceBasis(models.TextChoices):
        PACK = "pack", "Pack"
        WEIGHT = "weight", "Weight"

    source = models.ForeignKey(
        CatalogSource, on_delete=models.PROTECT, related_name="products"
    )
    import_batch = models.ForeignKey(
        CatalogImportBatch,
        on_delete=models.PROTECT,
        related_name="products",
    )
    ingredient = models.ForeignKey(
        CatalogIngredient,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="products",
    )
    external_id = models.CharField(max_length=120)
    normalized_external_id = models.CharField(max_length=120)
    title = models.CharField(max_length=200)
    normalized_title = models.CharField(max_length=200)
    category = models.CharField(max_length=64, blank=True, default="")
    raw_size = models.CharField(max_length=120)
    currency = models.CharField(max_length=3, default="USD")
    price_basis = models.CharField(
        max_length=8, choices=PriceBasis.choices, default=PriceBasis.PACK
    )
    pack_price_cents = models.PositiveIntegerField()
    pack_grams = models.PositiveIntegerField(null=True, blank=True)
    # Decimal like every other quantity column: the float originals drifted
    # (0.30000000000000004-style) once amounts were multiplied or compared.
    pack_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    pack_unit = models.CharField(max_length=64, null=True, blank=True)
    observed_at = models.DateTimeField()
    is_recipe_ready = models.BooleanField(default=False)
    is_available = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["title", "external_id"]
        indexes = [
            models.Index(fields=["source", "external_id"]),
            models.Index(fields=["normalized_title"]),
            models.Index(fields=["ingredient"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "normalized_external_id"],
                name="catalog_product_source_normalized_external_unique",
            ),
            models.UniqueConstraint(
                fields=["ingredient"],
                condition=Q(ingredient__isnull=False),
                name="catalog_product_one_per_ingredient",
            ),
            models.CheckConstraint(
                condition=(
                    Q(is_recipe_ready=False)
                    | (
                        Q(ingredient__isnull=False)
                        & Q(pack_grams__isnull=False)
                        & Q(pack_amount__isnull=False)
                        & Q(pack_unit__isnull=False)
                    )
                ),
                name="catalog_ready_requires_mapping_and_weight",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.source.key}: {self.external_id}"


class CatalogPriceObservation(UUIDTimestampModel):
    product = models.ForeignKey(
        CatalogProduct, on_delete=models.CASCADE, related_name="price_history"
    )
    import_batch = models.ForeignKey(
        CatalogImportBatch,
        on_delete=models.PROTECT,
        related_name="price_observations",
    )
    observed_at = models.DateTimeField()
    currency = models.CharField(max_length=3, default="USD")
    price_basis = models.CharField(
        max_length=8, choices=CatalogProduct.PriceBasis.choices
    )
    pack_price_cents = models.PositiveIntegerField()
    pack_grams = models.PositiveIntegerField(null=True, blank=True)
    pack_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    pack_unit = models.CharField(max_length=64, null=True, blank=True)
    raw_size = models.CharField(max_length=120)

    class Meta:
        ordering = ["-observed_at", "-created_at"]
        indexes = [models.Index(fields=["product", "-observed_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["product", "import_batch"],
                name="catalog_observation_product_batch_unique",
            )
        ]


class IngredientCategory(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ingredient_categories"
    )
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=64)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="ingredient_category_user_normalized_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


class NutritionSource(models.TextChoices):
    USDA_FDC = "usda_fdc", "USDA FoodData Central"
    CUSTOM = "custom", "Custom value"


class Ingredient(UUIDTimestampModel):
    class PriceSource(models.TextChoices):
        MASTER = "master", "Master price list"
        CATALOG = "catalog", "Catalog estimate"
        USER = "user", "User price"

    STATUS_ACTIVE = "active"
    STATUS_ARCHIVED = "archived"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_ARCHIVED, "Archived"),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="ingredients")
    edit_version = models.PositiveIntegerField(default=0)
    public_id = models.CharField(
        max_length=24, unique=True, default=generate_ingredient_public_id
    )
    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120)
    purchase_cost_cents = models.IntegerField()
    purchase_size = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    purchase_unit = models.CharField(max_length=64, null=True, blank=True)
    # The usable share of what is bought, after trim. Costing divides by it, so
    # a $10 case at 90% costs $11.11 a case of usable food. 100 means no loss.
    yield_percent = models.DecimalField(
        max_digits=7, decimal_places=3, default=Decimal("100")
    )
    catalog_ingredient = models.ForeignKey(
        CatalogIngredient,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tenant_ingredients",
    )
    catalog_product = models.ForeignKey(
        CatalogProduct,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="adopted_ingredients",
    )
    price_source = models.CharField(
        max_length=8,
        choices=PriceSource.choices,
        default=PriceSource.USER,
    )
    nutrition_source = models.CharField(
        max_length=24, blank=True, default="", choices=NutritionSource.choices
    )
    nutrition_source_id = models.CharField(max_length=64, blank=True, default="")
    nutrition_description = models.CharField(max_length=240, blank=True, default="")
    # The package's own ingredient list, as a branded USDA record carries it.
    # Blank for a common food or a typed custom value.
    nutrition_package_ingredients = models.TextField(blank=True, default="")
    nutrition_per_100g = models.JSONField(null=True, blank=True)
    nutrition_updated_at = models.DateTimeField(null=True, blank=True)
    # Not food: packaging, equipment. Contributes nothing to a label preview,
    # allergens included.
    non_edible = models.BooleanField(default=False)
    # Sugar, honey, syrups: every gram of sugar this ingredient brings is an
    # added sugar. FDC records never say so for a single-ingredient sweetener.
    sugars_are_added = models.BooleanField(default=False)
    # How the ingredient reads in a label's ingredient list; blank uses `name`.
    nutrition_label_name = models.CharField(max_length=120, blank=True, default="")
    category = models.ForeignKey(
        IngredientCategory,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ingredients",
    )
    # An ingredient the kitchen stopped buying. Archived rows stay linked to
    # the recipes that use them, so costing is unchanged; they drop out of the
    # pantry list and the pickers that start a new line.
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=STATUS_ACTIVE
    )
    tags = models.ManyToManyField(
        "IngredientTag",
        through="IngredientTagMembership",
        related_name="ingredients",
        blank=True,
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="ingredient_user_normalized_unique",
            ),
            models.CheckConstraint(
                condition=Q(yield_percent__gt=0, yield_percent__lte=100),
                name="ingredient_yield_percent_bounded",
            ),
        ]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.name


class IngredientMeasure(UUIDTimestampModel):
    """A tenant-owned household measure that overrides shared estimates."""

    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="measures"
    )
    unit = models.CharField(max_length=32, choices=IngredientMeasureUnit)
    amount = models.DecimalField(max_digits=15, decimal_places=6)
    grams = models.DecimalField(max_digits=15, decimal_places=6)
    qualifier = models.CharField(max_length=120, blank=True, default="")

    class Meta:
        ordering = ["ingredient__name", "unit", "qualifier"]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "unit", "qualifier"],
                name="ingredient_measure_unique",
            ),
            models.CheckConstraint(
                condition=Q(amount__gt=0), name="ingredient_measure_amount_positive"
            ),
            models.CheckConstraint(
                condition=Q(grams__gt=0), name="ingredient_measure_grams_positive"
            ),
        ]


class IngredientConversion(UUIDTimestampModel):
    """What one of the ingredient, as bought, comes to in other measures.

    Only consulted when a recipe asks in a unit the ingredient was not bought
    in. Buy 10 bushels and use 5, and nothing here is read: the cost per
    bushel answers it. A blank measure means unknown, not zero, and
    `average_weight` says to take the purchase size as the answer instead.
    """

    class Source(models.TextChoices):
        USER = "user", "User measured"
        CATALOG = "catalog", "Catalog estimate"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ingredient_conversions"
    )
    ingredient = models.OneToOneField(
        Ingredient, on_delete=models.CASCADE, related_name="conversion"
    )
    average_weight = models.BooleanField(default=True)
    weight_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    weight_unit = models.CharField(max_length=64, blank=True, default="")
    volume_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    volume_unit = models.CharField(max_length=64, blank=True, default="")
    each_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    each_unit = models.CharField(max_length=64, blank=True, default="")
    # Where the numbers came from, the pair a preparation already says. A
    # `catalog` row is a shared estimate the chef never measured.
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.USER)
    confidence = models.CharField(
        max_length=8,
        choices=IngredientMeasureConfidence.choices,
        default=IngredientMeasureConfidence.HIGH,
    )

    def __str__(self) -> str:
        return f"{self.ingredient.name} conversion"


class Preparation(UUIDTimestampModel):
    """A state an ingredient is used in — diced, yolks, clarified — with the
    yield it comes back at and either conversions of its own or an explicit
    choice to use the ingredient's standard conversion. A custom cup of yolks
    is not a cup of egg, so an incomplete custom conversion never falls back."""

    class Source(models.TextChoices):
        USER = "user", "User measured"
        CATALOG = "catalog", "Catalog estimate"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="preparations"
    )
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="preparations"
    )
    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120)
    yield_percent = models.DecimalField(
        max_digits=7, decimal_places=3, null=True, blank=True
    )
    # Where the yield came from. A seeded row is a shared estimate the chef
    # never measured; saving it again makes the row theirs.
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.USER)
    confidence = models.CharField(
        max_length=8,
        choices=IngredientMeasureConfidence.choices,
        default=IngredientMeasureConfidence.HIGH,
    )
    # On, the conversion is the pack it is bought as rather than its own row.
    average_weight = models.BooleanField(default=True)
    weight_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    weight_unit = models.CharField(max_length=64, blank=True, default="")
    volume_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    volume_unit = models.CharField(max_length=64, blank=True, default="")
    each_amount = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    each_unit = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["ingredient__name", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "normalized_name"],
                name="preparation_ingredient_name_unique",
            ),
            models.CheckConstraint(
                condition=(
                    Q(yield_percent__isnull=True)
                    | Q(yield_percent__gt=0, yield_percent__lte=1000)
                ),
                name="preparation_yield_percent_bounded",
            ),
            *[
                models.CheckConstraint(
                    condition=(
                        Q(**{f"{family}_amount__isnull": True, f"{family}_unit": ""})
                        | (
                            Q(**{f"{family}_amount__gt": 0})
                            & ~Q(**{f"{family}_unit": ""})
                        )
                    ),
                    name=f"preparation_{family}_pair_valid",
                )
                for family in ("weight", "volume", "each")
            ],
            models.CheckConstraint(
                condition=(
                    Q(average_weight=False)
                    | Q(
                        weight_amount__isnull=True,
                        weight_unit="",
                        volume_amount__isnull=True,
                        volume_unit="",
                        each_amount__isnull=True,
                        each_unit="",
                    )
                ),
                name="preparation_standard_conversion_empty",
            ),
        ]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.ingredient.name}: {self.name}"


class IngredientPrice(UUIDTimestampModel):
    class Source(models.TextChoices):
        USER = "user", "User price"
        MASTER = "master", "Master price list"
        CATALOG = "catalog", "Catalog estimate"
        SUPPLIER = "supplier", "Supplier import"

    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="price_history"
    )
    purchase_cost_cents = models.IntegerField()
    purchase_size = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    purchase_unit = models.CharField(max_length=64, null=True, blank=True)
    # Where this price came from. The FKs pin the exact supplier pack or
    # catalog observation when one exists; SET_NULL keeps the history row
    # meaningful after its origin is deleted.
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.USER)
    supplier_item = models.ForeignKey(
        "SupplierItem",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="price_history_entries",
    )
    catalog_observation = models.ForeignKey(
        CatalogPriceObservation,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ingredient_price_entries",
    )
    effective_at = models.DateTimeField()

    class Meta:
        ordering = ["-effective_at", "-created_at"]
        indexes = [models.Index(fields=["ingredient", "-effective_at"])]


class Supplier(UUIDTimestampModel):
    """A supplier the workspace buys from, keyed by the normalized name.

    `key` is what Invoice, SupplierItem and SupplierItemIgnore already store as
    a string; this record hangs contact details off it. The string columns stay
    the join, so a supplier row is bookkeeping over rows that exist without it.
    """

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="suppliers")
    key = models.CharField(max_length=64)
    name = models.CharField(max_length=120)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=64, blank=True)
    account_number = models.CharField(max_length=64, blank=True)
    notes = models.TextField(blank=True)
    # What this supplier's lines are filed under when nothing else remembers a
    # category for them. Null means the workspace has never said.
    default_category = models.ForeignKey(
        "ExpenseCategory",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="default_for_suppliers",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "key"], name="supplier_user_key_unique"
            )
        ]

    def __str__(self) -> str:
        return self.name


class SupplierItem(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="supplier_items"
    )
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="supplier_items"
    )
    supplier = models.CharField(max_length=64)
    external_id = models.CharField(max_length=120)
    title = models.CharField(max_length=200)
    raw_size = models.CharField(max_length=120)
    pack_price_cents = models.IntegerField()
    # A cache of the pack's weight, null when its unit carries no weight of its
    # own: a case of gallons or of pieces weighs what the ingredient says it
    # weighs, and the price is the pack, never the grams.
    pack_grams = models.IntegerField(null=True, blank=True)
    pack_amount = models.DecimalField(max_digits=15, decimal_places=6)
    pack_unit = models.CharField(max_length=64)
    purchased_quantity = models.FloatField(null=True, blank=True)
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    is_preferred = models.BooleanField(default=False)

    class Meta:
        ordering = ["supplier", "title", "external_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "supplier", "external_id"],
                name="supplier_item_user_supplier_external_unique",
            ),
            models.UniqueConstraint(
                fields=["ingredient"],
                condition=Q(is_preferred=True),
                name="supplier_item_one_preferred_per_ingredient",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.supplier}: {self.external_id} — {self.title}"


class SupplierItemIgnore(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ignored_supplier_items"
    )
    supplier = models.CharField(max_length=64)
    external_id = models.CharField(max_length=120)
    title = models.CharField(max_length=200)
    raw_size = models.CharField(max_length=120, blank=True)

    class Meta:
        ordering = ["supplier", "title", "external_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "supplier", "external_id"],
                name="supplier_ignore_user_supplier_external_unique",
            )
        ]


class IngredientImport(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ingredient_imports"
    )
    file_name = models.CharField(max_length=255)
    supplier = models.CharField(max_length=64, null=True, blank=True)
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    imported_count = models.PositiveIntegerField(default=0)
    created_count = models.PositiveIntegerField(default=0)
    updated_count = models.PositiveIntegerField(default=0)
    review_count = models.PositiveIntegerField(default=0)
    ignored_count = models.PositiveIntegerField(default=0)
    ignored_items = models.JSONField(default=list)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]


class IngredientImportItem(models.Model):
    class Operation(models.TextChoices):
        CREATED = "created", "Created"
        UPDATED = "updated", "Updated"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ingredient_import = models.ForeignKey(
        IngredientImport, on_delete=models.CASCADE, related_name="items"
    )
    position = models.PositiveIntegerField()
    supplier = models.CharField(max_length=64, null=True, blank=True)
    external_id = models.CharField(max_length=120, null=True, blank=True)
    operation = models.CharField(max_length=8, choices=Operation.choices)
    supplier_before = models.JSONField(null=True, blank=True)
    supplier_after = models.JSONField(null=True, blank=True)
    ignore_before = models.JSONField(null=True, blank=True)
    ingredient_before = models.JSONField(null=True, blank=True)
    ingredient_after = models.JSONField()
    ingredient_created = models.BooleanField(default=False)
    price_history_id = models.UUIDField(null=True, blank=True)

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient_import", "position"],
                name="ingredient_import_item_position_unique",
            )
        ]


class RecipePaste(UUIDTimestampModel):
    """The receipt for one pasted recipe.

    A sibling of `IngredientImport` rather than a variant of it: a paste writes
    a recipe body and preparations where an import writes supplier rows and
    prices, so the two share no guard. The stacks are independent — "the latest
    non-undone" is asked per table, because a paste and a supplier import do
    not order against each other.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_pastes"
    )
    recipe = models.ForeignKey(Recipe, on_delete=models.CASCADE, related_name="pastes")
    # {"id", "body", "method", "updatedAt"} either side of the write.
    recipe_before = models.JSONField()
    recipe_after = models.JSONField()
    line_count = models.PositiveIntegerField(default=0)
    ingredient_count = models.PositiveIntegerField(default=0)
    preparation_count = models.PositiveIntegerField(default=0)
    alias_count = models.PositiveIntegerField(default=0)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]


class RecipePasteItem(models.Model):
    """One row a paste created. A paste only ever creates, so there is no
    before snapshot: undoing a row means deleting it."""

    class Kind(models.TextChoices):
        INGREDIENT = "ingredient", "Ingredient"
        PREPARATION = "preparation", "Preparation"
        ALIAS = "alias", "Alias"
        MEASURE = "measure", "Measure"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipe_paste = models.ForeignKey(
        RecipePaste, on_delete=models.CASCADE, related_name="items"
    )
    position = models.PositiveIntegerField()
    kind = models.CharField(max_length=12, choices=Kind.choices)
    # {"id", "name", "updatedAt"} as the row stood when the paste wrote it.
    row_after = models.JSONField()

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(
                fields=["recipe_paste", "position"],
                name="recipe_paste_item_position_unique",
            )
        ]


class AnthropicCredential(UUIDTimestampModel):
    """The user's own Anthropic API key for invoice extraction — Forkluck
    doesn't pay for AI reads, the customer's key does (the "bring your own
    key" model, until plan-billed OAuth exists anywhere). Encrypted at rest
    with token_crypto like the POS OAuth tokens; only the last few characters
    are ever shown back."""

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="anthropic_credential"
    )
    api_key_encrypted = models.TextField()
    key_hint = models.CharField(max_length=8)


class ConnectorConnection(UUIDTimestampModel):
    """A provider-neutral pointer to credentials held by a connector service.

    The opaque token is issued by the remote service and encrypted locally so
    Forkluck can prove possession when it starts a run.  It is never a
    supplier login, and the supplier service independently binds it to this
    user and connection id.
    """

    class Status(models.TextChoices):
        CONNECTING = "connecting", "Connecting"
        CONNECTED = "connected", "Connected"
        NEEDS_RECONNECT = "needs_reconnect", "Needs reconnect"
        DISCONNECTED = "disconnected", "Disconnected"
        ERROR = "error", "Error"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="connector_connections"
    )
    provider_key = models.CharField(max_length=64)
    remote_connection_id = models.CharField(max_length=128)
    access_token_encrypted = models.TextField()
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.CONNECTING
    )
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    last_error_code = models.CharField(max_length=32, blank=True, default="")

    class Meta:
        ordering = ["provider_key"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "provider_key"],
                name="connector_connection_one_per_user_provider",
            ),
            models.UniqueConstraint(
                fields=["user", "remote_connection_id"],
                name="connector_connection_remote_id_per_user",
            ),
        ]


class ConnectorAuthorizationSession(UUIDTimestampModel):
    """The user-bound, short-lived state for a hosted connector sign-in."""

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="connector_authorizations"
    )
    provider_key = models.CharField(max_length=64)
    state = models.CharField(max_length=128, unique=True)
    remote_session_id = models.CharField(max_length=128)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["user", "expires_at"])]


class ConnectorSyncRun(UUIDTimestampModel):
    """One durable, user-owned request to import connector documents.

    Pages are acknowledged only after their invoice transaction commits.  A
    service can therefore replay an unacknowledged page without duplicating
    invoices: the established invoice fingerprint remains the idempotency
    boundary in the public application.
    """

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="connector_sync_runs"
    )
    connection = models.ForeignKey(
        ConnectorConnection,
        on_delete=models.CASCADE,
        related_name="sync_runs",
    )
    remote_run_id = models.CharField(max_length=128, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED
    )
    cursor = models.JSONField(default=dict, blank=True)
    acknowledged_page_id = models.CharField(max_length=128, blank=True, default="")
    pending_page_id = models.CharField(max_length=128, blank=True, default="")
    pending_page_is_final = models.BooleanField(default=False)
    progress = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    attempts = models.PositiveSmallIntegerField(default=0)
    available_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.UUIDField(null=True, blank=True, editable=False)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "available_at", "created_at"]),
            models.Index(fields=["user", "-created_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["connection"],
                condition=models.Q(status__in=["queued", "running"]),
                name="connector_sync_run_one_active_per_connection",
            )
        ]


# Serialized into the initial migration as a field default — do not rename.
def generate_invoice_public_id() -> str:
    return generate_public_id("inv")


class ExpenseCategory(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="expense_categories"
    )
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=64)
    # Lines in an is_ingredient category are eligible for the supplier-item /
    # price-history pipeline; every other category is expense-only.
    is_ingredient = models.BooleanField(default=False)
    # A supply category buys what the kitchen does not eat, so an item created
    # from one is a non-edible Ingredient. Supplies are costed like food, so a
    # supply category is is_ingredient too.
    is_supply = models.BooleanField(default=False)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="expense_category_user_normalized_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


# How the merchant paid. "" when the document does not say. A workspace can
# add its own methods on top of these four; see PaymentMethod.
INVOICE_PAYMENT_METHODS = ("", "cash", "card", "bank_transfer", "on_account")


class PaymentMethod(UUIDTimestampModel):
    """One workspace-defined way of paying, beyond the four built-ins.

    Invoices store the method as text, so deleting one here leaves every
    invoice reading exactly what it read before.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="payment_methods"
    )
    name = models.CharField(max_length=64)
    normalized_name = models.CharField(max_length=64)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="payment_method_user_normalized_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


class Invoice(UUIDTimestampModel):
    class DocumentType(models.TextChoices):
        INVOICE = "invoice", "Invoice"
        CREDIT_MEMO = "credit_memo", "Credit memo"
        RECEIPT = "receipt", "Receipt"
        REFUND = "refund", "Refund"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="invoices")
    edit_version = models.PositiveIntegerField(default=0)
    public_id = models.CharField(
        max_length=24, unique=True, default=generate_invoice_public_id
    )
    supplier = models.CharField(max_length=64)
    supplier_name = models.CharField(max_length=120)
    document_type = models.CharField(
        max_length=16, choices=DocumentType.choices, default=DocumentType.INVOICE
    )
    invoice_number = models.CharField(max_length=64, blank=True, default="")
    invoice_date = models.DateField(null=True, blank=True)
    # Null means the document did not print one; never backfilled from the
    # invoice date, because "no terms" is not "due on receipt".
    due_date = models.DateField(null=True, blank=True)
    # The currency the supplier printed on this document. An invoice is a
    # third-party record of what was actually paid, so it is never restated by
    # a workspace currency change — it is displayed in its own currency
    # instead. Set from the workspace currency at import, which is the
    # currency the extracted amounts were read as.
    currency_code = models.CharField(max_length=3, default="USD")
    # Printed grand total; negative for credit memos and refunds.
    total_cents = models.BigIntegerField()
    # Tax included in total_cents, 0 when the document prints none.
    tax_cents = models.BigIntegerField(default=0)
    # The printed subtotal before tax and charges. Null means the document did
    # not print it — it is never derived from the total.
    subtotal_cents = models.BigIntegerField(null=True, blank=True)
    notes = models.TextField(blank=True)
    payment_method = models.CharField(max_length=64, blank=True, default="")
    line_count = models.PositiveIntegerField(default=0)
    matched_line_count = models.PositiveIntegerField(default=0)
    unresolved_line_count = models.PositiveIntegerField(default=0)
    source_fingerprint = models.CharField(max_length=64)
    # "" for a document the user uploaded, "manual" for one typed in by hand,
    # "connector" for a supplier-connector import.
    source = models.CharField(max_length=16, blank=True, default="")
    file_name = models.CharField(max_length=255)
    # A document read from Drive is never stored; these point back at the
    # user's copy.
    drive_file_id = models.CharField(max_length=128, blank=True, default="")
    # Which document of that file this invoice was read from: 0 unless the
    # file held several receipts, so two invoices may share a drive_file_id.
    drive_file_part = models.PositiveIntegerField(default=0)
    drive_web_view_link = models.URLField(max_length=500, blank=True, default="")
    # Where the file the merchant uploaded is kept on our side, so the invoice
    # page can show it beside its lines. "" for a Drive or typed-in invoice.
    document_key = models.CharField(max_length=200, blank=True, default="")
    extraction_model = models.CharField(max_length=64, blank=True, default="")
    ingredient_import = models.ForeignKey(
        IngredientImport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="invoices",
    )

    class Meta:
        ordering = ["-invoice_date", "-created_at"]
        indexes = [
            models.Index(fields=["user", "-invoice_date"]),
            models.Index(fields=["user", "supplier"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "source_fingerprint"],
                name="invoice_user_fingerprint_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.supplier}: {self.invoice_number or self.public_id}"


class InvoiceLine(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="invoice_lines"
    )
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    position = models.PositiveIntegerField()
    sku = models.CharField(max_length=120, blank=True, default="")
    # The supplier-product identity this line is remembered under: the printed
    # code, else a `desc:` key off the description. Derived by
    # `supplier_item_key`; a client-supplied value is never trusted.
    item_key = models.CharField(max_length=120, blank=True, default="")
    description = models.CharField(max_length=240)
    quantity = models.DecimalField(
        max_digits=12, decimal_places=3, null=True, blank=True
    )
    unit = models.CharField(max_length=32, blank=True, default="")
    pack_size = models.CharField(max_length=120, blank=True, default="")
    # Denormalized from the parent invoice so a line can be formatted without
    # joining, and so the (amount, currency) pair travels together.
    currency_code = models.CharField(max_length=3, default="USD")
    unit_price_cents = models.IntegerField(null=True, blank=True)
    line_amount_cents = models.IntegerField()
    category = models.ForeignKey(
        ExpenseCategory,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="invoice_lines",
    )
    supplier_item = models.ForeignKey(
        SupplierItem,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="invoice_lines",
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="invoice_lines",
    )
    price_updated = models.BooleanField(default=False)
    needs_review = models.BooleanField(default=False)
    source_payload = models.JSONField(default=dict)

    class Meta:
        ordering = ["position"]
        indexes = [
            models.Index(fields=["user", "sku"]),
            models.Index(fields=["user", "item_key"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["invoice", "position"],
                name="invoice_line_position_unique",
            )
        ]


class IngredientInvoicePrice(UUIDTimestampModel):
    """One invoice purchase the kitchen may use to cost an ingredient.

    This is deliberately separate from ``InvoiceLine.ingredient`` and
    ``SupplierItem.ingredient``. Those fields classify a line and remember a
    supplier SKU; this relation is the many-to-many price shelf shown on an
    ingredient. A whole-egg purchase can therefore be available to both Egg
    and Egg yolk without either ingredient silently changing its active cost.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ingredient_invoice_prices"
    )
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="invoice_prices"
    )
    invoice_line = models.ForeignKey(
        InvoiceLine, on_delete=models.CASCADE, related_name="ingredient_prices"
    )
    ingredient_import = models.ForeignKey(
        IngredientImport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="invoice_prices",
    )
    purchase_size = models.DecimalField(
        max_digits=15, decimal_places=6, null=True, blank=True
    )
    purchase_unit = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["-invoice_line__invoice__invoice_date", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "invoice_line"],
                name="ingredient_invoice_price_line_unique",
            ),
            models.CheckConstraint(
                condition=(
                    Q(purchase_size__isnull=True, purchase_unit="")
                    | (Q(purchase_size__gt=0) & ~Q(purchase_unit=""))
                ),
                name="ingredient_invoice_price_measure_pair",
            ),
        ]


class DriveFolderSource(UUIDTimestampModel):
    """The Google Drive folder a workspace's supplier documents arrive in.

    Forkluck stores the folder id and its name, never any file bytes: the
    documents stay in the merchant's Drive and are read by the Next process
    at extraction time.
    """

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="drive_folder_source"
    )
    folder_id = models.CharField(max_length=128)
    folder_name = models.CharField(max_length=255)
    # When the poller last listed this folder in full. Null means it has not
    # yet: the folder was connected before Changes were being tracked, or has
    # been connected since the last poll, so a Changes page alone would not
    # mention the documents already sitting in it.
    registered_at = models.DateTimeField(null=True, blank=True)

    def __str__(self) -> str:
        return self.folder_name or self.folder_id


class DriveWatchState(models.Model):
    """The Google Drive Changes cursor the Next process polls with.

    One row for the whole installation rather than one per workspace: the
    service account holds a single Changes feed covering every folder shared
    with it, so there is one page token to advance and one poll to record.
    """

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    page_token = models.CharField(max_length=256, blank=True, default="")
    polled_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls) -> "DriveWatchState":
        row, _ = cls.objects.get_or_create(pk=cls.SINGLETON_PK)
        return row

    def __str__(self) -> str:
        return f"Drive watch (polled {self.polled_at or 'never'})"


class DriveFile(UUIDTimestampModel):
    """Every file the poller has seen in this workspace's Drive folder.

    Ids and metadata only, never file bytes: the documents stay in the
    merchant's Drive and are read by the Next process at extraction time.
    `created_at` is when the workspace first saw the file; `seen_at` is the
    last registration that mentioned it.
    """

    class Status(models.TextChoices):
        NEW = "new", "New"
        # The watcher read this file on its own and nobody has confirmed the
        # invoice it produced yet.
        READY = "ready", "Ready"
        IMPORTED = "imported", "Imported"
        SKIPPED = "skipped", "Skipped"
        FAILED = "failed", "Failed"
        UNSUPPORTED = "unsupported", "Unsupported"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="drive_files")
    drive_file_id = models.CharField(max_length=128)
    name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=128, blank=True, default="")
    size_bytes = models.BigIntegerField(null=True, blank=True)
    modified_time = models.DateTimeField(null=True, blank=True)
    web_view_link = models.URLField(max_length=500, blank=True, default="")
    # The sub-folder path under the connected folder ("2026-08"), "" at its
    # root, so the screen can group a year of receipts the way Drive shows it.
    folder_path = models.CharField(max_length=255, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.NEW)
    # For an unsupported file the support verdict that ruled it out ("heic",
    # "unsupported", "too_large"); for a skipped or failed one free text.
    reason = models.CharField(max_length=255, blank=True, default="")
    invoice = models.ForeignKey(
        Invoice,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="drive_files",
    )
    seen_at = models.DateTimeField()

    class Meta:
        indexes = [models.Index(fields=["user", "status"])]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "drive_file_id"],
                name="drive_file_user_file_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name or self.drive_file_id


class DriveFileExtraction(UUIDTimestampModel):
    """One document the watcher read out of a Drive file, before anyone
    confirmed it.

    A file may hold several documents — a scanned bundle of receipts, a photo
    of two of them — so this is one row per *part*: `part` is the 0-based
    index, and `page_start`/`page_end` (a PDF page range, 0-based inclusive)
    or `region` (a photo crop in fractions of the prepared image) say which
    slice of the file it was read from. All three are null on a whole-file
    document, which is part 0.

    Its own row rather than columns on DriveFile so a registration's
    `bulk_update` stays a metadata write and never carries a document
    (`InvoiceLine.source_payload` and `SyncRun.result` keep their JSON the
    same way). `document` is opaque to Django — the Next process writes the
    normalized invoice it read plus the file name and link — because the
    workspace-dependent part of a review (categories, duplicates, line
    matches) is recomputed when the inbox opens, not stored here.

    `status` is this part's own verdict: the merchant imports or skips one
    receipt of a bundle at a time, and the file itself only leaves `ready`
    once no part is still waiting.
    """

    class Status(models.TextChoices):
        READY = "ready", "Ready"
        IMPORTED = "imported", "Imported"
        SKIPPED = "skipped", "Skipped"

    drive_file = models.ForeignKey(
        DriveFile, on_delete=models.CASCADE, related_name="extractions"
    )
    part = models.PositiveIntegerField(default=0)
    # 0-based, inclusive, and absolute within the whole file, so the viewer
    # needs no offset to draw a line box on the page it came from.
    page_start = models.PositiveIntegerField(null=True, blank=True)
    page_end = models.PositiveIntegerField(null=True, blank=True)
    # {x0, y0, x1, y1} as fractions of the prepared image, top-left origin.
    region = models.JSONField(null=True, blank=True)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.READY
    )
    document = models.JSONField(default=dict)
    model = models.CharField(max_length=120, blank=True)
    escalated = models.BooleanField(default=False)
    extracted_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["drive_file", "part"],
                name="drive_file_extraction_part_unique",
            )
        ]

    def __str__(self) -> str:
        return f"Extraction {self.part} of {self.drive_file_id}"


class ReceiptFeedback(UUIDTimestampModel):
    """A user's report, retained independently of importing the receipt.

    Snapshots are untrusted feedback for staff review, never pricing inputs
    or automatically accepted training labels.
    """

    class Rating(models.TextChoices):
        UP = "up", "Thumbs up"
        DOWN = "down", "Thumbs down"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="receipt_feedback")
    submission_id = models.UUIDField()
    rating = models.CharField(max_length=4, choices=Rating.choices)
    note = models.TextField(blank=True, default="")
    file_name = models.CharField(max_length=255)
    supplier_name = models.CharField(max_length=120, blank=True, default="")
    extraction_model = models.CharField(max_length=64)
    extraction = models.JSONField(null=True, blank=True)
    original = models.JSONField(default=dict)
    corrected = models.JSONField(default=dict)
    reviewed = models.BooleanField(default=False)

    class Meta:
        verbose_name_plural = "Receipt feedback"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "submission_id"], name="receipt_feedback_user_submission_unique"
            )
        ]

    def __str__(self) -> str:
        return f"{self.get_rating_display()}: {self.file_name}"


class InvoiceExtraction(UUIDTimestampModel):
    """The model's raw read of the document this invoice was made from.

    Its own row rather than columns on Invoice so an invoice save never
    carries a document (`DriveFileExtraction` keeps its JSON the same way).
    `document` is opaque to Django. It sits beside the invoice the merchant
    confirmed so read and correction survive the import as one labelled
    example for the extraction eval; nothing reads it yet.
    `Invoice.extraction_model` already names what read it.
    """

    invoice = models.OneToOneField(
        Invoice, on_delete=models.CASCADE, related_name="extraction"
    )
    document = models.JSONField(default=dict)
    # True when the validator sent the document to a second, tier-3 read and
    # that read won.
    escalated = models.BooleanField(default=False)

    def __str__(self) -> str:
        return f"Extraction of {self.invoice_id}"


class Employee(UUIDTimestampModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="employees")
    name = models.CharField(max_length=150)
    normalized_name = models.CharField(max_length=150)
    is_active = models.BooleanField(default=True)
    # Their shifts and hours still count; only their money stops, the way a
    # recipe line left out of cost keeps its quantity.
    excluded_from_cost = models.BooleanField(default=False)
    created_by_import = models.ForeignKey(
        "LaborImport",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_employees",
    )
    # The import that took this employee off the archive. Undoing that import
    # has to put them back, so the reactivation is recorded the same way the
    # creation is.
    reactivated_by_import = models.ForeignKey(
        "LaborImport",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reactivated_employees",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="employee_user_normalized_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


class LaborImport(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="labor_imports"
    )
    file_name = models.CharField(max_length=255)
    source = models.CharField(max_length=32, default="csv")
    timezone = models.CharField(max_length=64, default="UTC")
    mapping = models.JSONField(default=dict)
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    imported_count = models.PositiveIntegerField(default=0)
    created_employee_count = models.PositiveIntegerField(default=0)
    duplicate_count = models.PositiveIntegerField(default=0)
    skipped_count = models.PositiveIntegerField(default=0)
    excluded_count = models.PositiveIntegerField(default=0)
    total_seconds = models.PositiveBigIntegerField(default=0)
    total_labor_cost_cents = models.BigIntegerField(default=0)
    uncosted_count = models.PositiveIntegerField(default=0)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]


class EmployeeHourlyRate(UUIDTimestampModel):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, related_name="hourly_rates"
    )
    hourly_rate_cents = models.PositiveIntegerField()
    effective_from = models.DateField()
    source_import = models.ForeignKey(
        LaborImport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_rates",
    )

    class Meta:
        ordering = ["-effective_from", "-created_at"]
        indexes = [models.Index(fields=["employee", "-effective_from"])]
        constraints = [
            models.UniqueConstraint(
                fields=["employee", "effective_from"],
                name="employee_rate_effective_unique",
            )
        ]


class TimeEntry(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="time_entries"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, related_name="time_entries"
    )
    labor_import = models.ForeignKey(
        LaborImport, on_delete=models.CASCADE, related_name="time_entries"
    )
    source_position = models.PositiveIntegerField()
    source_fingerprint = models.CharField(max_length=64)
    clock_in = models.DateTimeField()
    clock_out = models.DateTimeField()
    paid_seconds = models.PositiveIntegerField()
    # What the workspace's unpaid-break policy took off this shift. The
    # clocked duration above stays the imported fact and never moves, so a
    # policy change is always reversible and the shift can show both.
    unpaid_break_seconds = models.PositiveIntegerField(default=0)
    # The break the timesheet itself reported. Recorded, never deducted:
    # a provider's break column is already reflected in the hours it hands
    # us, so subtracting it again would bill the break twice.
    break_seconds = models.PositiveIntegerField(default=0)
    time_adjustment_seconds = models.IntegerField(default=0)
    earnings_adjustment_cents = models.IntegerField(default=0)
    hourly_rate_override_cents = models.PositiveIntegerField(null=True, blank=True)
    hourly_rate_cents = models.PositiveIntegerField(null=True, blank=True)
    labor_cost_cents = models.IntegerField(null=True, blank=True)
    comment = models.CharField(max_length=500, blank=True)
    source_payload = models.JSONField(default=dict)

    class Meta:
        verbose_name_plural = "time entries"
        ordering = ["-clock_in", "-created_at"]
        indexes = [
            models.Index(fields=["user", "-clock_in"]),
            models.Index(fields=["employee", "-clock_in"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "source_fingerprint"],
                name="time_entry_user_fingerprint_unique",
            ),
            models.UniqueConstraint(
                fields=["labor_import", "source_position"],
                name="time_entry_import_position_unique",
            ),
            models.CheckConstraint(
                condition=Q(clock_out__gt=models.F("clock_in")),
                name="time_entry_clock_out_after_in",
            ),
            # A deduction may take the whole shift but never more: a payable
            # duration below zero would pay the kitchen to open.
            models.CheckConstraint(
                condition=Q(unpaid_break_seconds__lte=models.F("paid_seconds")),
                name="time_entry_unpaid_break_within_paid",
            ),
        ]


class SalesImport(UUIDTimestampModel):
    class Channel(models.TextChoices):
        SQUARE = "square", "Square"
        SHOPIFY = "shopify", "Shopify"
        MANUAL = "manual", "Manual"

    class Source(models.TextChoices):
        CSV = "csv", "CSV"
        API = "api", "API"
        MANUAL = "manual", "Manual"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_imports"
    )
    file_name = models.CharField(max_length=255)
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.CSV)
    channel = models.CharField(max_length=16, choices=Channel.choices)
    # Blank for CSV imports. API imports retain the provider's merchant/shop
    # identity so reconnecting a different account cannot inherit history.
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    timezone = models.CharField(max_length=64, default="UTC")
    currency_code = models.CharField(max_length=3, default="USD")
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    imported_count = models.PositiveIntegerField(default=0)
    duplicate_count = models.PositiveIntegerField(default=0)
    skipped_count = models.PositiveIntegerField(default=0)
    unmapped_count = models.PositiveIntegerField(default=0)
    ignored_count = models.PositiveIntegerField(default=0)
    ignored_items = models.JSONField(default=list)
    order_count = models.PositiveIntegerField(default=0)
    created_product_count = models.PositiveIntegerField(default=0)
    gross_cents = models.BigIntegerField(default=0)
    discount_cents = models.BigIntegerField(default=0)
    net_sales_cents = models.BigIntegerField(default=0)
    tax_cents = models.BigIntegerField(default=0)
    refund_cents = models.BigIntegerField(default=0)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=Q(refund_cents__gte=0),
                name="sales_import_refund_cents_nonnegative",
            ),
            models.UniqueConstraint(
                fields=["user", "channel", "period_start"],
                condition=Q(
                    channel="manual",
                    source="manual",
                    period_start__isnull=False,
                ),
                name="sales_manual_import_user_month_unique",
            ),
        ]


class SalesProduct(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_products"
    )
    edit_version = models.PositiveIntegerField(default=0)
    # Globally unique, opaque, stable id used by Product Hub URLs. The first
    # product migration adds this nullable and the following data migration
    # fills legacy rows before the final migration enforces the invariant.
    public_id = models.CharField(
        max_length=24, unique=True, default=generate_sales_product_public_id
    )
    name = models.CharField(max_length=200)
    normalized_name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    sell_price_cents = models.IntegerField(default=0)
    # What one sold unit of this product is: a piece, a gram, a slice. Blank
    # is "each", which is what every product meant before the column existed.
    #
    # It names the unit a variant's multiplier and a consumption figure are
    # counted in; it does not convert and does not enter costing, so a product
    # sold by the gram composes and costs exactly as one sold by the piece.
    base_unit = models.CharField(
        max_length=32, blank=True, default="", choices=product_unit_choices
    )
    category = models.CharField(max_length=120, blank=True, default="")
    is_active = models.BooleanField(default=True)
    created_by_import = models.ForeignKey(
        SalesImport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_products",
    )
    # Auto-matching invents a product to hang both channels' variants on.
    # Turning the setting off withdraws only products it created and the
    # merchant never touched; renaming one promotes it to `manual`.
    link_source = models.CharField(
        max_length=16,
        choices=[
            ("manual", "Chosen by the merchant"),
            ("auto_sku", "Matched automatically on SKU"),
        ],
        default="manual",
    )

    class Meta:
        ordering = ["name", "created_at"]
        indexes = [
            models.Index(fields=["user", "normalized_name"]),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def sku(self) -> str:
        """The one SKU that stands for the product in a list or an export."""
        rows = list(self.skus.all())
        for row in rows:
            if row.quantity_multiplier == 1:
                return row.sku
        return rows[0].sku if rows else ""


class SalesProductSku(UUIDTimestampModel):
    """One POS SKU that sells this product, and how many units one sale is.

    A pack SKU (a box of six under its own code) is the same product counted
    six times, not a variant and not a bundle. A SKU names one product per
    workspace.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_product_skus"
    )
    product = models.ForeignKey(
        SalesProduct, on_delete=models.CASCADE, related_name="skus"
    )
    sku = models.CharField(max_length=120)
    normalized_sku = models.CharField(max_length=120)
    quantity_multiplier = models.DecimalField(
        max_digits=12, decimal_places=3, default=Decimal("1")
    )
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_sku"],
                name="sales_product_sku_unique",
            ),
            models.CheckConstraint(
                condition=Q(quantity_multiplier__gt=0),
                name="sales_product_sku_multiplier_positive",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        if not self.sku.strip():
            raise ValidationError({"sku": "SKU is required."})
        if self.quantity_multiplier <= 0:
            raise ValidationError(
                {"quantity_multiplier": "Units per sale must be above zero."}
            )
        if self.quantity_multiplier > MAX_VARIANT_MULTIPLIER:
            raise ValidationError(
                {"quantity_multiplier": "Units per sale is too large."}
            )


class SalesProductComponent(UUIDTimestampModel):
    product = models.ForeignKey(
        SalesProduct, on_delete=models.CASCADE, related_name="components"
    )
    position = models.PositiveIntegerField(default=0)
    recipe = models.ForeignKey(
        Recipe,
        on_delete=models.PROTECT,
        related_name="sales_product_components",
        null=True,
        blank=True,
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT,
        related_name="sales_product_components",
        null=True,
        blank=True,
    )
    # PROTECT, not CASCADE: deleting a member would silently rewrite the
    # bundle's composition, and with it its cost and every figure derived
    # from it. A merchant unlinks the member first.
    component_product = models.ForeignKey(
        SalesProduct,
        on_delete=models.PROTECT,
        related_name="bundle_components",
        null=True,
        blank=True,
    )
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    # An ingredient component is measured in its unit. A product component
    # counts whole members and has none. A recipe component has either: blank
    # means whole batches per sold product, a unit means that much of the
    # recipe batch (500 g of a 20 kg batch), resolved against its yield.
    unit = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["product", "recipe"],
                condition=Q(recipe__isnull=False),
                name="sales_product_component_recipe_unique",
            ),
            models.UniqueConstraint(
                fields=["product", "ingredient"],
                condition=Q(ingredient__isnull=False),
                name="sales_product_component_ingredient_unique",
            ),
            models.UniqueConstraint(
                fields=["product", "component_product"],
                condition=Q(component_product__isnull=False),
                name="sales_product_component_product_unique",
            ),
            models.CheckConstraint(
                condition=Q(quantity__gt=0),
                name="sales_product_component_quantity_positive",
            ),
            models.CheckConstraint(
                condition=(
                    Q(
                        recipe__isnull=False,
                        ingredient__isnull=True,
                        component_product__isnull=True,
                    )
                    | Q(
                        recipe__isnull=True,
                        ingredient__isnull=False,
                        component_product__isnull=True,
                    )
                    & ~Q(unit="")
                    | Q(
                        recipe__isnull=True,
                        ingredient__isnull=True,
                        component_product__isnull=False,
                        unit="",
                    )
                ),
                name="sales_product_component_target_and_unit",
            ),
            models.CheckConstraint(
                condition=~Q(component_product=F("product")),
                name="sales_product_component_not_self",
            ),
        ]

    def clean(self):
        super().clean()
        targets = [self.recipe_id, self.ingredient_id, self.component_product_id]
        if sum(1 for target in targets if target is not None) != 1:
            raise ValidationError(
                "A product component is a recipe, an ingredient, or a product"
            )
        if self.ingredient_id is not None and not self.unit:
            raise ValidationError("An ingredient product component needs a unit")
        if self.component_product_id is None:
            return
        if self.unit:
            raise ValidationError("A product component has no unit")
        if self.component_product_id == self.product_id:
            raise ValidationError("A product cannot contain itself")
        if self.product_id and self.component_product.user_id != self.product.user_id:
            raise ValidationError("A bundle member belongs to another workspace")

        # Walk the current graph before accepting this edge, the way the
        # subrecipe guard above does, so admin, imports and every action path
        # get the same refusal. Iterative: a catalog is far wider than a
        # recipe tree and must not put its depth on the Python stack.
        edges: dict[uuid.UUID, set[uuid.UUID]] = {}
        for parent_id, child_id in SalesProductComponent.objects.filter(
            product__user_id=self.component_product.user_id,
            component_product__isnull=False,
        ).values_list("product_id", "component_product_id"):
            edges.setdefault(parent_id, set()).add(child_id)
        seen = {self.component_product_id}
        pending = [self.component_product_id]
        while pending:
            for child_id in edges.get(pending.pop(), ()):
                if child_id == self.product_id:
                    raise ValidationError("Bundles cannot contain a cycle")
                if child_id not in seen:
                    seen.add(child_id)
                    pending.append(child_id)


# Serialized into the initial migration as a field default — do not rename.
def generate_menu_public_id() -> str:
    return generate_public_id("mnu")


class Menu(UUIDTimestampModel):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="menus")
    edit_version = models.PositiveIntegerField(default=0)
    public_id = models.CharField(
        max_length=24, unique=True, default=generate_menu_public_id
    )
    name = models.CharField(max_length=120)
    # Both dates or neither: a one-sided period has no window to import.
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["user", "-updated_at"])]

    def __str__(self) -> str:
        return self.name


class MenuItem(UUIDTimestampModel):
    menu = models.ForeignKey(Menu, on_delete=models.CASCADE, related_name="items")
    position = models.PositiveIntegerField(default=0)
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=120, blank=True, default="")
    sell_price_cents = models.IntegerField()
    qty_sold = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    # A row is one recipe or one product; its name, category and food cost
    # are read through that link. Neither set is a migration leftover the
    # worksheet shows as needing a link and the save action refuses.
    product = models.ForeignKey(
        SalesProduct,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="menu_items",
    )
    recipe = models.ForeignKey(
        Recipe,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="menu_items",
    )
    # The baseline the worksheet's variance is measured against, written once
    # when the row is created and never restated by a later save.
    original_sell_price_cents = models.IntegerField()
    original_qty_sold = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    original_food_cost_cents = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["menu", "position"])]
        constraints = [
            models.CheckConstraint(
                condition=~(Q(recipe__isnull=False) & Q(product__isnull=False)),
                name="menu_item_one_link",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class SalesProductVariant(UUIDTimestampModel):
    class IdentityKind(models.TextChoices):
        ITEM = "item", "Item or variation"
        MODIFIER = "modifier", "Modifier"

    class LinkSource(models.TextChoices):
        MANUAL = "manual", "Chosen by the merchant"
        AUTO_SKU = "auto_sku", "Matched automatically on SKU"
        SYSTEM = "system", "System"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_product_variants"
    )
    product = models.ForeignKey(
        SalesProduct,
        on_delete=models.CASCADE,
        related_name="variants",
        null=True,
        blank=True,
    )
    channel = models.CharField(max_length=16, choices=SalesImport.Channel.choices)
    # The provider merchant/shop this approval belongs to. CSV-only mappings
    # use a blank account id and remain scoped by their selected channel.
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    match_key = models.CharField(max_length=500)
    sku = models.CharField(max_length=120, blank=True)
    external_name = models.CharField(max_length=240)
    # Every `external_*` field holds the provider's own string, never ours:
    # this is the POS variation title (Square `item_variation_data.name`,
    # Shopify `ProductVariant.title`), not a SalesProductVariant.
    external_variant_title = models.CharField(max_length=200, blank=True)
    identity_kind = models.CharField(
        max_length=16,
        choices=IdentityKind.choices,
        default=IdentityKind.ITEM,
    )
    external_object_id = models.CharField(max_length=192, blank=True, default="")
    # Shopify fallback when the ProductVariant object is unavailable. The
    # exact variant title remains part of match_key.
    product_external_object_id = models.CharField(
        max_length=192, blank=True, default=""
    )
    quantity_multiplier = models.DecimalField(
        max_digits=12, decimal_places=3, default=Decimal("1")
    )
    created_by_import = models.ForeignKey(
        SalesImport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_variants",
    )
    # Who decided this link. `created_by_import` records which import carried a
    # row, not whether a person chose it, so it cannot answer that. Only links
    # still marked `auto_sku` may be withdrawn when the matching setting is
    # turned off; any merchant edit promotes one to `manual` for good.
    link_source = models.CharField(
        max_length=16, choices=LinkSource.choices, default=LinkSource.MANUAL
    )
    # How much of the line's money belongs to this variant's products. Null is
    # "not said yet" and reads as 100; the remainder is unattributed.
    attribution_percent = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["channel", "external_name"]
        indexes = [models.Index(fields=["user", "channel", "sku"])]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "channel", "provider_account_id", "match_key"],
                name="sales_variant_scoped_match_unique",
            ),
            models.UniqueConstraint(
                fields=["user", "product"],
                condition=Q(channel="manual", product__isnull=False),
                name="sales_variant_one_manual_product",
            ),
            models.CheckConstraint(
                condition=Q(quantity_multiplier__gt=0),
                name="sales_variant_multiplier_positive",
            ),
            models.CheckConstraint(
                condition=(
                    Q(attribution_percent__isnull=True)
                    | Q(
                        attribution_percent__gte=0,
                        attribution_percent__lte=100,
                    )
                ),
                name="sales_variant_attribution_percent_range",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        errors: dict[str, str] = {}
        multiplier = self.quantity_multiplier
        if multiplier is not None:
            if multiplier <= 0:
                errors["quantity_multiplier"] = "Units per sale must be above zero."
            elif multiplier > MAX_VARIANT_MULTIPLIER:
                errors["quantity_multiplier"] = "Units per sale is too large."
        if self.product_id is None:
            errors["product"] = "A variant needs a product."
        if self.attribution_percent is not None and not (
            0 <= self.attribution_percent <= 100
        ):
            errors["attribution_percent"] = (
                "Attribution must be between 0 and 100 percent."
            )
        if errors:
            raise ValidationError(errors)

    def save(self, *args, **kwargs) -> None:
        if not self.provider_account_id and self.match_key.startswith(
            f"{self.channel}:"
        ):
            connection = SalesChannelConnection.objects.filter(
                user_id=self.user_id, provider=self.channel
            ).first()
            if connection is not None:
                self.provider_account_id = connection.provider_account_id
        super().save(*args, **kwargs)


class SalesCatalogItem(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_catalog_items"
    )
    channel = models.CharField(max_length=16, choices=SALES_PROVIDER_CHOICES)
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    match_key = models.CharField(max_length=500)
    external_object_id = models.CharField(max_length=192, blank=True, default="")
    sku = models.CharField(max_length=120, blank=True)
    item_name = models.CharField(max_length=240)
    external_variant_title = models.CharField(max_length=200, blank=True)
    category = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "channel", "provider_account_id", "match_key"],
                name="sales_catalog_item_scoped_match_unique",
            )
        ]


class SalesModifierList(UUIDTimestampModel):
    """A provider-owned modifier list imported from its catalog.

    The list is presentation and organization; sales interpretation still
    resolves each contained modifier through ``SalesProductVariant`` so
    catalog imports and historical sales share one mapping engine.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_modifier_lists"
    )
    channel = models.CharField(max_length=16, choices=SALES_PROVIDER_CHOICES)
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    external_object_id = models.CharField(max_length=192)
    name = models.CharField(max_length=255)
    modifier_type = models.CharField(max_length=16, default="list")
    selection_type = models.CharField(max_length=16, blank=True, default="")
    ordinal = models.IntegerField(default=0)
    allow_quantities = models.BooleanField(default=False)
    min_selected = models.IntegerField(default=-1)
    max_selected = models.IntegerField(default=-1)
    is_active = models.BooleanField(default=True)
    last_synced_at = models.DateTimeField()

    class Meta:
        ordering = ["ordinal", "name", "created_at"]
        indexes = [models.Index(fields=["user", "channel", "is_active"])]
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "user",
                    "channel",
                    "provider_account_id",
                    "external_object_id",
                ],
                name="sales_modifier_list_scoped_external_unique",
            )
        ]


class SalesModifierOption(UUIDTimestampModel):
    """One provider catalog modifier inside a ``SalesModifierList``."""

    modifier_list = models.ForeignKey(
        SalesModifierList, on_delete=models.CASCADE, related_name="options"
    )
    external_object_id = models.CharField(max_length=192)
    name = models.CharField(max_length=255)
    ordinal = models.IntegerField(default=0)
    price_cents = models.BigIntegerField(null=True, blank=True)
    currency_code = models.CharField(max_length=3, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["ordinal", "name", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["modifier_list", "external_object_id"],
                name="sales_modifier_option_list_external_unique",
            )
        ]


def resolve_sold_on(sold_at: datetime, timezone_name: str) -> date_type:
    """The provider-local calendar date a sale belongs to.

    The zone is stored per line, because one workspace can sell through
    providers in different zones, so this cannot be derived from sold_at alone.
    An unrecognized zone falls back to UTC rather than failing the import.
    """
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    if sold_at.tzinfo is None:
        sold_at = sold_at.replace(tzinfo=ZoneInfo("UTC"))
    return sold_at.astimezone(zone).date()


class SalesLineManager(models.Manager):
    """Keeps `sold_on` derived no matter how a line is written.

    bulk_create bypasses save(), which is exactly how the import and sync paths
    write lines, so deriving it only in save() would leave the column blank on
    every real write. Filling it here means no call site — present or future —
    has to remember.
    """

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            if obj.sold_at is not None:
                obj.sold_on = resolve_sold_on(obj.sold_at, obj.timezone)
        return super().bulk_create(objs, *args, **kwargs)


class SalesLine(UUIDTimestampModel):
    objects = SalesLineManager()

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sales_lines")
    sales_import = models.ForeignKey(
        SalesImport, on_delete=models.CASCADE, related_name="lines"
    )
    product = models.ForeignKey(
        SalesProduct,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sales_lines",
    )
    variant = models.ForeignKey(
        SalesProductVariant,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sales_lines",
    )
    channel = models.CharField(max_length=16, choices=SalesImport.Channel.choices)
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    source_position = models.PositiveIntegerField()
    source_fingerprint = models.CharField(max_length=64)
    # Immutable provider ledger identity. Blank only for CSV or provider rows
    # that genuinely do not expose one; those retain fingerprint deduplication.
    provider_record_id = models.CharField(max_length=500, blank=True, default="")
    external_order_id = models.CharField(max_length=160)
    sold_at = models.DateTimeField()
    timezone = models.CharField(max_length=64, default="UTC")
    # sold_at resolved into `timezone`'s calendar date, stored so the daily
    # rollup can group in SQL. The zone is per row — a workspace can sell
    # through providers in different zones — so this cannot be derived in a
    # query from sold_at alone. Derived by SalesLineManager and save().
    sold_on = models.DateField()
    sku = models.CharField(max_length=120, blank=True)
    item_name = models.CharField(max_length=240)
    external_variant_title = models.CharField(max_length=200, blank=True)
    group_key = models.CharField(max_length=500, blank=True, default="")
    # The identity actually reviewed/mapped: provider object id first, then
    # Shopify product+variant, finally the legacy SKU/name group key.
    match_key = models.CharField(max_length=500, blank=True, default="")
    # The provider variation identity. Kept alongside group_key so an
    # object-ID variant approved later can still claim stored history.
    external_object_id = models.CharField(max_length=192, blank=True, default="")
    product_external_object_id = models.CharField(
        max_length=192, blank=True, default=""
    )
    # The provider's own category display name for the sold item, captured at
    # sync time. Decoration for review triage only — never a matching input,
    # and blank whenever the provider gives none.
    external_category = models.CharField(max_length=120, blank=True, default="")
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    gross_cents = models.BigIntegerField(default=0)
    discount_cents = models.BigIntegerField(default=0)
    net_sales_cents = models.BigIntegerField(default=0)
    tax_cents = models.BigIntegerField(default=0)
    refund_cents = models.BigIntegerField(default=0)
    currency_code = models.CharField(max_length=3, default="USD")
    location = models.CharField(max_length=200, blank=True)
    employee_name = models.CharField(max_length=150, blank=True)
    order_source = models.CharField(max_length=120, blank=True)
    financial_status = models.CharField(max_length=64, blank=True)
    fulfillment_status = models.CharField(max_length=64, blank=True)
    source_payload = models.JSONField(default=dict)

    class Meta:
        ordering = ["-sold_at", "-created_at"]
        indexes = [
            models.Index(fields=["user", "-sold_at"]),
            models.Index(fields=["product", "-sold_at"]),
            # Serves the daily rollup's GROUP BY / ORDER BY / LIMIT.
            models.Index(fields=["user", "-sold_on"]),
            models.Index(fields=["user", "channel", "external_order_id"]),
            models.Index(fields=["user", "channel", "group_key"]),
            models.Index(
                fields=["user", "channel", "provider_account_id", "match_key"]
            ),
            models.Index(
                fields=[
                    "user",
                    "channel",
                    "provider_account_id",
                    "provider_record_id",
                ]
            ),
            models.Index(fields=["user", "channel", "external_object_id"]),
            models.Index(fields=["user", "channel", "external_category"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "user",
                    "channel",
                    "provider_account_id",
                    "source_fingerprint",
                ],
                name="sales_line_scoped_fingerprint_unique",
            ),
            models.UniqueConstraint(
                fields=[
                    "user",
                    "channel",
                    "provider_account_id",
                    "provider_record_id",
                ],
                condition=~Q(provider_record_id=""),
                name="sales_line_scoped_provider_record_unique",
            ),
            models.UniqueConstraint(
                fields=["sales_import", "source_position"],
                name="sales_line_import_position_unique",
            ),
            models.CheckConstraint(
                condition=Q(refund_cents__gte=0),
                name="sales_line_refund_cents_nonnegative",
            ),
        ]

    def save(self, *args, **kwargs) -> None:
        # Compatibility for direct model creation (apps/web/tests/admin/maintenance).
        # Import paths set the stable key explicitly before bulk_create.
        if not self.match_key:
            self.match_key = self.group_key
        if not self.provider_account_id and self.sales_import_id:
            self.provider_account_id = self.sales_import.provider_account_id
        # sold_on is derived, never supplied by a caller. Import paths set it
        # explicitly because bulk_create does not call save().
        if self.sold_at is not None:
            self.sold_on = resolve_sold_on(self.sold_at, self.timezone)
            update_fields = kwargs.get("update_fields")
            if update_fields is not None and {"sold_at", "timezone"}.intersection(
                update_fields
            ):
                kwargs["update_fields"] = {*update_fields, "sold_on"}
        super().save(*args, **kwargs)


class SalesLineModifier(UUIDTimestampModel):
    """A modifier selected on a financial line.

    Stores provider source facts plus the approved mapping attachment. It
    never owns revenue: gross/net/tax stay on the parent `SalesLine`.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_line_modifiers"
    )
    sales_line = models.ForeignKey(
        SalesLine, on_delete=models.CASCADE, related_name="modifiers"
    )
    variant = models.ForeignKey(
        SalesProductVariant,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sales_line_modifiers",
    )
    source_uid = models.CharField(max_length=120, blank=True)
    source_fingerprint = models.CharField(max_length=64)
    external_object_id = models.CharField(max_length=192, blank=True)
    sku = models.CharField(max_length=120, blank=True)
    name = models.CharField(max_length=255)
    match_key = models.CharField(max_length=500)
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    base_price_cents = models.BigIntegerField(null=True, blank=True)
    total_price_cents = models.BigIntegerField(null=True, blank=True)
    source_payload = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["user", "match_key"]),
            models.Index(fields=["variant", "sales_line"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["sales_line", "source_fingerprint"],
                name="sales_line_modifier_fingerprint_unique",
            ),
            models.CheckConstraint(
                condition=Q(quantity__gte=0),
                name="sales_line_modifier_quantity_non_negative",
            ),
        ]

    def clean(self) -> None:
        # A cross-table constraint is not expressible in the database, so the
        # variant/user pairing is enforced here and at every create path.
        super().clean()
        errors: dict[str, str] = {}
        if self.quantity is not None and self.quantity < 0:
            errors["quantity"] = "Modifier quantity cannot be negative."
        variant_id = self.variant_id
        if variant_id:
            variant = self.variant
            if variant.identity_kind != SalesProductVariant.IdentityKind.MODIFIER:
                errors["variant"] = "Only a modifier identity can be attached here."
            elif variant.user_id != self.user_id:
                errors["variant"] = "That identity belongs to another account."
        if errors:
            raise ValidationError(errors)


class SalesIgnoreRule(UUIDTimestampModel):
    """A standing instruction to ignore whatever matches it.

    The rule is the *reason*; the `SalesSkuIgnore` rows carrying its id are its
    materialized effect. Removing the reason removes the effect (CASCADE), so
    the effect never holds state that can outlive its cause.
    """

    class Field(models.TextChoices):
        SKU = "sku", "SKU"
        TITLE = "title", "Title"
        VARIANT = "variant", "Variant"

    class Operator(models.TextChoices):
        IS = "is", "is"
        STARTS_WITH = "starts_with", "starts with"
        CONTAINS = "contains", "contains"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_ignore_rules"
    )
    # NULL is every channel, so one rule can stand for a name a merchant never
    # wants to see wherever it is sold.
    channel = models.CharField(
        max_length=16, choices=SALES_PROVIDER_CHOICES, null=True, blank=True
    )
    enabled = models.BooleanField(default=True)
    # [{"field": ..., "operator": ..., "value": ...}], ANDed. Nothing ever
    # queries into it, so a child table would buy a prefetch and no capability.
    conditions = models.JSONField(default=list)

    class Meta:
        # Newest first: the rule a merchant just wrote is the one that claims a
        # contested identity, which is what they expect to have happened. A
        # named channel sorts before the catch-all, so it claims first; spelling
        # that out keeps SQLite and PostgreSQL from disagreeing about NULLs.
        ordering = [models.F("channel").asc(nulls_last=True), "-created_at"]
        indexes = [models.Index(fields=["user", "enabled"])]


class SalesSkuIgnore(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_sku_ignores"
    )
    channel = models.CharField(max_length=16, choices=SALES_PROVIDER_CHOICES)
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    match_key = models.CharField(max_length=500)
    sku = models.CharField(max_length=120, blank=True)
    external_name = models.CharField(max_length=240)
    external_variant_title = models.CharField(max_length=200, blank=True)
    # NULL is a merchant's own decision about this identity; a rule id means the
    # row is that rule's output and only the rule may take it back.
    rule = models.ForeignKey(
        SalesIgnoreRule,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="ignores",
    )

    class Meta:
        ordering = ["channel", "external_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "channel", "provider_account_id", "match_key"],
                name="sales_sku_ignore_scoped_match_unique",
            )
        ]

    def save(self, *args, **kwargs) -> None:
        if not self.provider_account_id and self.match_key.startswith(
            f"{self.channel}:"
        ):
            connection = SalesChannelConnection.objects.filter(
                user_id=self.user_id, provider=self.channel
            ).first()
            if connection is not None:
                self.provider_account_id = connection.provider_account_id
        super().save(*args, **kwargs)


class SalesChannelConnection(UUIDTimestampModel):
    """An OAuth link between one user and one POS/commerce provider.

    Tokens are stored as AES-256-GCM envelopes (token_crypto.py) — never
    plaintext, and never serialized to the frontend. Deleting the row is the
    disconnect; imported sales survive because nothing here is FK'd from them.
    `sync_watermark` is the end of the last fully completed provider session.
    A persisted `sync_cursor` owns in-session progress; new sessions re-read a
    two-day overlap and rely on source identity to stay idempotent.
    """

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        NEEDS_RECONNECT = "needs_reconnect", "Needs reconnect"
        DISCONNECTING = "disconnecting", "Disconnecting"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sales_channel_connections"
    )
    provider = models.CharField(max_length=16, choices=SALES_PROVIDER_CHOICES)
    # Every credential replacement advances the generation. Durable work
    # copies it so an old worker can never write through a reused connection
    # row after reconnect.
    generation = models.PositiveBigIntegerField(default=1)
    # Square merchant id or canonical Shopify shop domain. Unlike the
    # connection row id this survives token refreshes and changes on account
    # replacement, making it the namespace for mappings and deduplication.
    provider_account_id = models.CharField(max_length=192, blank=True, default="")
    access_token_encrypted = models.TextField()
    # Shopify offline tokens have no refresh token; Square rotates one.
    refresh_token_encrypted = models.TextField(blank=True, default="")
    token_expires_at = models.DateTimeField(null=True, blank=True)
    merchant_id = models.CharField(max_length=64, blank=True, default="")
    shop_domain = models.CharField(max_length=120, blank=True, default="")
    location_ids = models.JSONField(default=list, blank=True)
    # Square locations own their calendar zone. Kept internal: financial
    # lines copy the resolved zone and remain the audited read source.
    location_timezones = models.JSONField(default=dict, blank=True)
    scopes = models.CharField(max_length=500, blank=True, default="")
    provider_timezone = models.CharField(max_length=64, default="UTC")
    currency_code = models.CharField(max_length=3, default="USD")
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE
    )
    sync_watermark = models.DateTimeField(null=True, blank=True)
    # Exact provider-session progress. The global watermark advances only
    # after every location chunk in this cursor has completed.
    sync_cursor = models.JSONField(default=dict, blank=True)
    backfilled_at = models.DateTimeField(null=True, blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    modifier_catalog_synced_at = models.DateTimeField(null=True, blank=True)
    # Distinguishes a successful empty provider catalog from one never fetched.
    product_catalog_synced_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    # A short database lease prevents two web workers from downloading the
    # same provider history at once. The token identifies the owner so a late
    # request cannot clear a newer lease after its own lease expires.
    sync_lease_token = models.UUIDField(null=True, blank=True, editable=False)
    sync_lease_started_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["provider", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "provider"],
                name="sales_connection_user_provider_unique",
            ),
            models.CheckConstraint(
                condition=Q(generation__gt=0),
                name="sales_connection_generation_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.provider} ({self.merchant_id or self.shop_domain})"

    def save(self, *args, **kwargs) -> None:
        if not self.provider_account_id:
            self.provider_account_id = (
                self.merchant_id
                if self.provider == SalesImport.Channel.SQUARE
                else self.shop_domain
            )
        super().save(*args, **kwargs)


class SyncRunQuerySet(models.QuerySet):
    """State transitions shared by reconnect, disconnect, undo, and recovery."""

    def cancel_active(
        self,
        *,
        connection: SalesChannelConnection | None = None,
        generation: int | None = None,
        now: datetime | None = None,
    ) -> int:
        """Cancel matching queued/running rows under the caller's transaction.

        Callers take the workspace and connection locks first. Selecting the
        run rows here completes the repository's workspace -> connection ->
        run lock order and keeps terminal timestamps/progress coherent.
        """

        rows = self.select_for_update().filter(status__in=["queued", "running"])
        if connection is not None:
            rows = rows.filter(connection=connection)
            if generation is not None:
                rows = rows.filter(connection_generation=generation)
        else:
            return 0
        cancelled_at = now or timezone.now()
        cancelled = list(rows)
        for run in cancelled:
            run.status = "cancelled"
            run.claim_token = None
            run.heartbeat_at = None
            run.finished_at = cancelled_at
            run.error = ""
            run.progress = {**run.progress, "phase": "cancelled"}
            run.checkpoint = {}
            run.updated_at = cancelled_at
        if cancelled:
            self.bulk_update(
                cancelled,
                [
                    "status",
                    "claim_token",
                    "heartbeat_at",
                    "finished_at",
                    "error",
                    "progress",
                    "checkpoint",
                    "updated_at",
                ],
            )
        return len(cancelled)


class SyncRun(UUIDTimestampModel):
    """Durable execution record for one requested POS sales sync.

    The provider account is copied onto the run so a disconnected or replaced
    connection can never make an old queued job run against a different
    merchant.  ``claim_token`` is the worker lease owner; all completion and
    retry writes compare it so a recovered stale worker cannot overwrite a
    newer attempt.
    """

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    DEFAULT_MAX_ATTEMPTS = 3

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="pos_sync_runs"
    )
    connection = models.ForeignKey(
        SalesChannelConnection,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sync_runs",
    )
    provider = models.CharField(max_length=16, choices=SALES_PROVIDER_CHOICES)
    provider_account_id = models.CharField(max_length=192)
    connection_generation = models.PositiveBigIntegerField(default=1)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.QUEUED
    )
    progress = models.JSONField(default=dict, blank=True)
    # Provider-neutral resume position captured after every bounded pass. The
    # connection watermark remains authoritative; this snapshot makes the job
    # independently auditable and visible through its status endpoint.
    cursor = models.JSONField(default=dict, blank=True)
    result = models.JSONField(default=dict, blank=True)
    # Internal pass checkpoint. It is deliberately not serialized: the public
    # result remains the last fully finalized receipt while crash recovery
    # finishes the local ignore-rule step recorded here.
    checkpoint = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=DEFAULT_MAX_ATTEMPTS)
    available_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.UUIDField(null=True, blank=True, editable=False)

    objects = SyncRunQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["status", "available_at", "created_at"],
                name="forkluck_sy_status_44d019_idx",
            ),
            models.Index(
                fields=["user", "-created_at"],
                name="forkluck_sy_user_id_caef46_idx",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(attempts__lte=models.F("max_attempts")),
                name="pos_sync_run_attempts_bounded",
            ),
            models.CheckConstraint(
                condition=Q(connection_generation__gt=0),
                name="pos_sync_run_generation_positive",
            ),
            models.UniqueConstraint(
                fields=["connection", "connection_generation"],
                condition=models.Q(status__in=["queued", "running"]),
                name="pos_sync_run_one_active_per_generation",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.provider} sync ({self.status})"


class CatalogIngredientAlias(UUIDTimestampModel):
    """A source vocabulary spelling for a shared catalog identity.

    Aliases are intentionally not globally unique: two catalog identities may
    share a spelling while a later review resolves the ambiguity. Matchers
    must therefore consider the target as well as this normalized key.
    """

    ingredient = models.ForeignKey(
        CatalogIngredient,
        on_delete=models.CASCADE,
        related_name="aliases",
    )
    text = models.CharField(max_length=200)
    normalized_text = models.CharField(max_length=200)
    provenance = models.CharField(max_length=120, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name_plural = "catalog ingredient aliases"
        ordering = ["normalized_text", "text"]
        indexes = [
            models.Index(fields=["normalized_text", "is_active"]),
            models.Index(fields=["ingredient", "normalized_text"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "provenance", "normalized_text"],
                name="catalog_alias_ingredient_source_unique",
            )
        ]

    def save(self, *args, **kwargs):
        self.normalized_text = normalized_name(self.text)
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "text" in update_fields:
            kwargs["update_fields"] = [*update_fields, "normalized_text"]
        super().save(*args, **kwargs)


class RecipeLineMatch(UUIDTimestampModel):
    """A tenant-owned recipe-line spelling resolved to one pantry identity.

    A component recipe is a valid target, but ordinary recipes are rejected by
    ``clean`` so the model cannot accidentally make a recipe cycle part of
    ingredient matching.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_line_matches"
    )
    text = models.CharField(max_length=200)
    normalized_text = models.CharField(max_length=200)
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="recipe_line_matches",
    )
    component_recipe = models.ForeignKey(
        Recipe,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="ingredient_line_matches",
    )

    class Meta:
        verbose_name_plural = "recipe line matches"
        ordering = ["normalized_text"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_text"],
                name="recipe_line_match_user_text_unique",
            ),
            models.CheckConstraint(
                condition=(
                    (Q(ingredient__isnull=False) & Q(component_recipe__isnull=True))
                    | (Q(ingredient__isnull=True) & Q(component_recipe__isnull=False))
                ),
                name="recipe_line_match_exactly_one_target",
            ),
        ]

    def clean(self):
        super().clean()
        if (
            self.component_recipe_id
            and self.component_recipe.kind != Recipe.KIND_COMPONENT
        ):
            raise ValidationError(
                {"component_recipe": "Only component recipes can be matched."}
            )

    def save(self, *args, **kwargs):
        self.normalized_text = normalized_name(self.text)
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "text" in update_fields:
            kwargs["update_fields"] = [*update_fields, "normalized_text"]
        super().save(*args, **kwargs)


class IngredientTag(UUIDTimestampModel):
    """A tenant-owned label for pantry ingredients."""

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="ingredient_tags"
    )
    name = models.CharField(max_length=80)
    normalized_name = models.CharField(max_length=80)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "normalized_name"],
                name="ingredient_tag_user_normalized_unique",
            )
        ]

    def save(self, *args, **kwargs):
        derive_normalized_name(self, kwargs)
        super().save(*args, **kwargs)


class IngredientTagMembership(models.Model):
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="tag_memberships"
    )
    tag = models.ForeignKey(
        IngredientTag, on_delete=models.CASCADE, related_name="memberships"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "tag"], name="ingredient_tag_membership_unique"
            )
        ]


class Allergen(models.TextChoices):
    """Kitchen allergen tags.

    The first nine are the US major allergens; the next five complete the
    EU Annex II list; the last four are sensitivities kitchens track but no
    label regulates. A label preview declares only its format's subset.
    """

    MILK = "milk", "Milk"
    EGG = "egg", "Egg"
    FISH = "fish", "Fish"
    SHELLFISH = "shellfish", "Crustacean shellfish"
    TREE_NUTS = "tree_nuts", "Tree nuts"
    PEANUT = "peanut", "Peanut"
    WHEAT = "wheat", "Wheat"
    SOY = "soy", "Soy"
    SESAME = "sesame", "Sesame"
    SULPHITES = "sulphites", "Sulphites"
    GLUTEN_CEREALS = "gluten_cereals", "Cereals containing gluten"
    MOLLUSKS = "mollusks", "Mollusks"
    MUSTARD = "mustard", "Mustard"
    LUPIN = "lupin", "Lupin"
    CELERY = "celery", "Celery"
    ALLIUM = "allium", "Allium"
    NIGHTSHADES = "nightshades", "Nightshades"
    LEGUMES = "legumes", "Legumes"
    STONE_FRUIT = "stone_fruit", "Stone fruit"


class IngredientAllergenStatus(models.TextChoices):
    CONTAINS = "contains", "Contains"
    MAY_CONTAIN = "mayContain", "May contain"
    DOES_NOT_CONTAIN = "doesNotContain", "Does not contain"
    # Brand-dependent: the catalog cannot say, so the kitchen reads the
    # package. A hint, never an assertion, so no rollup counts it.
    CHECK_LABEL = "checkLabel", "Check the label"


class CatalogIngredientAllergen(UUIDTimestampModel):
    """Sourced default allergen assertion for a catalog identity."""

    ingredient = models.ForeignKey(
        CatalogIngredient,
        on_delete=models.CASCADE,
        related_name="allergen_defaults",
    )
    allergen = models.CharField(max_length=16, choices=Allergen.choices)
    status = models.CharField(
        max_length=16,
        choices=IngredientAllergenStatus.choices,
        default=IngredientAllergenStatus.DOES_NOT_CONTAIN,
    )
    source_kind = models.CharField(max_length=32)
    source_ref = models.CharField(max_length=120)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "allergen"], name="catalog_allergen_unique"
            )
        ]


class IngredientAllergenOverride(UUIDTimestampModel):
    """A tenant's explicit replacement for a catalog allergen default."""

    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name="allergen_overrides",
    )
    allergen = models.CharField(max_length=16, choices=Allergen.choices)
    status = models.CharField(
        max_length=16,
        choices=IngredientAllergenStatus.choices,
        default=IngredientAllergenStatus.DOES_NOT_CONTAIN,
    )
    source_kind = models.CharField(max_length=32, default="user")
    source_ref = models.CharField(max_length=120, default="manual")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["ingredient", "allergen"],
                name="ingredient_allergen_override_unique",
            )
        ]


class NutritionRequest(UUIDTimestampModel):
    """Package values a user typed for an ingredient no USDA record matches.

    Support reads the request in the staff console and applies it, which
    turns it into the ingredient's custom nutrition source. The row is the
    record; the email is a notification.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPLIED = "applied", "Applied"
        DISMISSED = "dismissed", "Dismissed"
        SUPERSEDED = "superseded", "Superseded"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="nutrition_requests"
    )
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="nutrition_requests"
    )
    serving_grams = models.DecimalField(max_digits=15, decimal_places=6)
    # The label values as typed, per serving; None where the package is silent.
    values = models.JSONField()
    # The same values as a per-100 g composition in the Ingredient snapshot
    # shape, computed when the request was made so applying it needs no math.
    per_100g = models.JSONField()
    source = models.CharField(max_length=240, blank=True, default="")
    note = models.TextField(blank=True, default="")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.PENDING
    )
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=Q(serving_grams__gt=0),
                name="nutrition_request_serving_grams_positive",
            ),
            models.UniqueConstraint(
                fields=["ingredient"],
                condition=Q(status="pending"),
                name="nutrition_request_one_pending",
            ),
        ]

    def apply(self, *, force: bool = False) -> None:
        """Make this request the ingredient's nutrition source.

        Refuses when the user linked a record after asking, unless forced:
        a request from last week must not overwrite this morning's choice.
        """
        from django.db import transaction

        with transaction.atomic():
            ingredient = Ingredient.objects.select_for_update().get(
                pk=self.ingredient_id
            )
            if (
                not force
                and ingredient.nutrition_updated_at is not None
                and ingredient.nutrition_updated_at > self.created_at
            ):
                raise ValueError(
                    "The ingredient was linked to a newer record after this request"
                )
            now = timezone.now()
            ingredient.nutrition_source = NutritionSource.CUSTOM
            ingredient.nutrition_source_id = ""
            ingredient.nutrition_description = self.source or "Custom nutrition value"
            # A typed label carries no package ingredient list.
            ingredient.nutrition_package_ingredients = ""
            ingredient.nutrition_per_100g = self.per_100g
            ingredient.nutrition_updated_at = now
            ingredient.save(
                update_fields=[
                    "nutrition_source",
                    "nutrition_source_id",
                    "nutrition_description",
                    "nutrition_package_ingredients",
                    "nutrition_per_100g",
                    "nutrition_updated_at",
                    "updated_at",
                ]
            )
            self.status = self.Status.APPLIED
            self.resolved_at = now
            self.save(update_fields=["status", "resolved_at", "updated_at"])


class MasterPriceDismissal(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="dismissed_master_prices"
    )
    master_price_id = models.UUIDField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "master_price_id"],
                name="master_price_dismissal_user_unique",
            )
        ]


class MasterPriceAccess(UUIDTimestampModel):
    class Bucket(models.TextChoices):
        SEARCH = "search", "Search"
        MATCH = "match", "Exact recipe match"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="master_price_accesses"
    )
    bucket = models.CharField(max_length=8, choices=Bucket.choices)

    class Meta:
        indexes = [models.Index(fields=["user", "bucket", "created_at"])]


class CatalogAccess(UUIDTimestampModel):
    class Bucket(models.TextChoices):
        SEARCH = "search", "Search"
        MATCH = "match", "Exact recipe match"

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="catalog_accesses"
    )
    bucket = models.CharField(max_length=8, choices=Bucket.choices)

    class Meta:
        indexes = [models.Index(fields=["user", "bucket", "created_at"])]


class RecipeExternalRef(UUIDTimestampModel):
    SYSTEM_SQUARE = "square"
    SYSTEM_SHOPIFY = "shopify"
    SYSTEM_CHOICES = [
        (SYSTEM_SQUARE, "Square"),
        (SYSTEM_SHOPIFY, "Shopify"),
    ]

    KIND_ITEM = "item"
    KIND_VARIATION = "variation"
    KIND_HANDLE = "handle"
    KIND_SKU = "sku"
    KIND_CHOICES = [
        (KIND_ITEM, "Item"),
        (KIND_VARIATION, "Variation"),
        (KIND_HANDLE, "Handle"),
        (KIND_SKU, "SKU"),
    ]

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="recipe_external_refs"
    )
    recipe = models.ForeignKey(
        Recipe, on_delete=models.CASCADE, related_name="external_refs"
    )
    system = models.CharField(max_length=16, choices=SYSTEM_CHOICES)
    ref_kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    external_id = models.CharField(max_length=160)

    class Meta:
        ordering = ["system", "ref_kind"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "system", "ref_kind", "external_id"],
                name="recipe_external_ref_unique",
            ),
            models.CheckConstraint(
                condition=~Q(external_id=""),
                name="recipe_external_ref_id_not_blank",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.system}:{self.ref_kind}:{self.external_id}"


class BenchCostSettings(models.Model):
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="benchcost_settings",
    )
    wage_per_hour_cents = models.IntegerField(default=2000)
    measurement_system = models.CharField(max_length=8, default="metric")
    currency_code = models.CharField(max_length=3, default="USD")
    # Whose labelling rules the kitchen works to. Blank is "never chose", which
    # the read derives from the currency; a stored choice is always honoured.
    label_region = models.CharField(
        max_length=2,
        blank=True,
        default="",
        choices=[
            ("", "Not chosen"),
            ("us", "United States"),
            ("eu", "United Kingdom and EU"),
        ],
    )
    food_cost_target_bps = models.IntegerField(default=3000)
    overtime_weekly_minutes = models.IntegerField(default=2400)
    # What the employer pays on top of a wage — payroll taxes, statutory
    # contributions, whatever the kitchen loads onto an hour — in basis
    # points. A rate, not money, so a currency conversion leaves it alone.
    # Zero is "never set", which every workspace predating the field reads
    # as, and it keeps labor cost exactly the wage.
    payroll_tax_bps = models.IntegerField(default=0)
    # An auto-deducted unpaid meal break: `unpaid_break_minutes` comes off
    # every whole `unpaid_break_per_hours` block a shift runs. Zero minutes
    # is off, and is the default — a timesheet's own hours are the truth
    # until a kitchen says its shifts carry an unpaid break.
    unpaid_break_minutes = models.PositiveIntegerField(default=0)
    unpaid_break_per_hours = models.PositiveIntegerField(default=8)
    product_auto_match_enabled = models.BooleanField(default=True)
    # The zone the kitchen reports in. Blank is "never chose", which the read
    # infers from the newest sale or shift; a stored choice always wins.
    timezone = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        verbose_name_plural = "bench cost settings"


class BillingAccount(models.Model):
    """One denormalized entitlement and reconciliation fence per user."""

    class DeletionState(models.TextChoices):
        ACTIVE = "active", "Active"
        DELETING = "deleting", "Deleting"

    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="billing_account",
    )
    status = models.CharField(max_length=24, default="none")
    # A lock now means the account is being deleted; a lapsed one is on Free.
    locked = models.BooleanField(default=False)
    trial_end = models.DateTimeField(null=True, blank=True)
    last_reconciled_at = models.DateTimeField(null=True, blank=True)
    reconcile_generation = models.PositiveBigIntegerField(default=0)
    deletion_state = models.CharField(
        max_length=16,
        choices=DeletionState.choices,
        default=DeletionState.ACTIVE,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class StripeCustomer(UUIDTimestampModel):
    """One provider customer identity owned by exactly one billing account."""

    account = models.ForeignKey(
        BillingAccount,
        on_delete=models.CASCADE,
        related_name="stripe_customers",
    )
    # Null reserves a durable local identity before the provider call. Stripe's
    # idempotency result fills it after the external effect succeeds.
    stripe_customer_id = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        unique=True,
    )
    creation_idempotency_key = models.CharField(max_length=160, unique=True)
    is_primary = models.BooleanField(default=False)
    livemode = models.BooleanField(default=False)
    provider_created_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["account"],
                condition=Q(is_primary=True),
                name="stripe_customer_one_primary_per_account",
            ),
            models.CheckConstraint(
                condition=(
                    Q(stripe_customer_id__isnull=True) | ~Q(stripe_customer_id="")
                ),
                name="stripe_customer_id_null_or_nonblank",
            ),
            models.CheckConstraint(
                condition=~Q(creation_idempotency_key=""),
                name="stripe_customer_idempotency_key_nonblank",
            ),
        ]


class StripeSubscription(UUIDTimestampModel):
    """A complete provider subscription snapshot retained across lifecycles."""

    customer = models.ForeignKey(
        StripeCustomer,
        on_delete=models.CASCADE,
        related_name="subscriptions",
    )
    stripe_subscription_id = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=24, default="none")
    trial_end = models.DateTimeField(null=True, blank=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancel_at_period_end = models.BooleanField(default=False)
    price_id = models.CharField(max_length=64, blank=True, default="")
    product_id = models.CharField(max_length=64, blank=True, default="")
    livemode = models.BooleanField(default=False)
    provider_created_at = models.DateTimeField(null=True, blank=True)
    provider_present = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~Q(stripe_subscription_id=""),
                name="stripe_subscription_id_nonblank",
            )
        ]


class StripeCheckoutAttempt(UUIDTimestampModel):
    """A stable Checkout command identity that survives provider timeouts."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        OPEN = "open", "Open"
        COMPLETED = "completed", "Completed"
        EXPIRED = "expired", "Expired"

    account = models.ForeignKey(
        BillingAccount,
        on_delete=models.CASCADE,
        related_name="checkout_attempts",
    )
    customer = models.ForeignKey(
        StripeCustomer,
        on_delete=models.CASCADE,
        related_name="checkout_attempts",
    )
    stripe_checkout_session_id = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        unique=True,
    )
    stripe_subscription_id = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        unique=True,
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    with_trial = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["account"],
                condition=Q(status__in=["pending", "open"]),
                name="stripe_checkout_one_active_per_account",
            ),
            models.CheckConstraint(
                condition=(
                    Q(stripe_checkout_session_id__isnull=True)
                    | ~Q(stripe_checkout_session_id="")
                ),
                name="stripe_checkout_session_id_null_or_nonblank",
            ),
            models.CheckConstraint(
                condition=(
                    Q(stripe_subscription_id__isnull=True)
                    | ~Q(stripe_subscription_id="")
                ),
                name="stripe_checkout_subscription_id_null_or_nonblank",
            ),
        ]


class StripeWebhookEvent(UUIDTimestampModel):
    """A signed Stripe delivery and its recoverable processing lease."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        PROCESSED = "processed", "Processed"

    event_id = models.CharField(max_length=255, unique=True)
    account = models.ForeignKey(
        BillingAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="webhook_events",
    )
    event_type = models.CharField(max_length=80)
    stripe_customer_id = models.CharField(max_length=64, blank=True, default="")
    stripe_subscription_id = models.CharField(max_length=64, blank=True, default="")
    livemode = models.BooleanField(default=False)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    processing_started_at = models.DateTimeField(null=True, blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=240, blank=True, default="")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~Q(event_id=""),
                name="stripe_webhook_event_id_nonblank",
            )
        ]


class StripeRetiredCustomer(models.Model):
    """Provider identity tombstone retained after its local user is deleted."""

    stripe_customer_id = models.CharField(max_length=64, primary_key=True)
    livemode = models.BooleanField(default=False)
    retired_at = models.DateTimeField(auto_now_add=True)


class StripeBillingConfiguration(models.Model):
    """The one locally attested set of live Stripe billing objects and secrets."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    stripe_account_id = models.CharField(max_length=64)
    price_id = models.CharField(max_length=64)
    product_id = models.CharField(max_length=64)
    webhook_endpoint_id = models.CharField(max_length=64)
    api_version = models.CharField(max_length=32)
    livemode = models.BooleanField(default=False)
    api_secret_digest = models.CharField(max_length=64)
    webhook_secret_digest = models.CharField(max_length=64)
    webhook_secret_verified = models.BooleanField(default=False)
    validated_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(id=1),
                name="stripe_billing_configuration_singleton",
            )
        ]


class CurrencyConversion(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="currency_conversions"
    )
    source_currency = models.CharField(max_length=3)
    target_currency = models.CharField(max_length=3)
    rate = models.DecimalField(max_digits=20, decimal_places=12)
    rate_date = models.DateField()
    provider = models.CharField(max_length=120)
    converted_counts = models.JSONField(default=dict)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]


class BenchCostRecipe(UUIDTimestampModel):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="benchcost_recipes"
    )
    recipe = models.ForeignKey(
        Recipe,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="cost_entries",
    )
    name = models.CharField(max_length=120)
    ingredient_cost_cents = models.IntegerField(default=0)
    packaging_cost_cents = models.IntegerField(default=0)
    batch_yield = models.IntegerField()
    sellable_yield = models.IntegerField(null=True, blank=True)
    position = models.IntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["user", "position"])]
        constraints = [
            # A recipe has at most one cost record. Conditional because
            # recipe is nullable: standalone bench-cost entries, and entries
            # detached when their recipe was deleted, are unconstrained.
            models.UniqueConstraint(
                fields=["user", "recipe"],
                condition=models.Q(recipe__isnull=False),
                name="bench_cost_recipe_user_recipe_unique",
            )
        ]

    def __str__(self) -> str:
        return self.name


class BenchCostStep(models.Model):
    class Kind(models.TextChoices):
        ACTIVE = "active", "Active"
        PASSIVE = "passive", "Passive"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipe = models.ForeignKey(
        BenchCostRecipe, on_delete=models.CASCADE, related_name="steps"
    )
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.ACTIVE)
    covers = models.IntegerField(default=1)
    position = models.IntegerField(default=0)

    class Meta:
        ordering = ["position"]

    def __str__(self) -> str:
        return self.name


class BenchCostTiming(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    step = models.ForeignKey(
        BenchCostStep, on_delete=models.CASCADE, related_name="timings"
    )
    seconds = models.IntegerField()
    yield_count = models.IntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class ActivityEvent(UUIDTimestampModel):
    """One line in the workspace's activity log.

    `user` is the workspace the event belongs to; `actor` is whoever did it,
    which may be a shared collaborator or nobody at all for a background sync.
    The actor's name is copied in so a deleted account still reads back.
    """

    RESOURCE_TYPES = (
        "recipe",
        "ingredient",
        "menu",
        "invoice",
        "category",
        "import",
        "settings",
        "connection",
        "workspace",
    )
    EVENTS = (
        "added",
        "edited",
        "deleted",
        "archived",
        "restored",
        "imported",
        "connected",
        "disconnected",
    )

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="activity_events"
    )
    actor = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    actor_name = models.CharField(max_length=120, blank=True, default="")
    resource_type = models.CharField(max_length=32)
    resource_id = models.UUIDField(null=True, blank=True)
    event = models.CharField(max_length=16)
    name = models.CharField(max_length=200, blank=True, default="")
    context = models.JSONField(default=dict)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.resource_type} {self.event}"
