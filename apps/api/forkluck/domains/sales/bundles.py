"""The product graph: products whose components are other products.

A bundle is an ordinary product that happens to contain products. This module
loads that graph once per request and answers what the catalog and the ledger
ask of it: what is inside this product, what does selling it consume, and how
does one sale's money divide between the products it contained.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP

from ...models import SalesProduct, SalesProductComponent, User


def product_components_by_product(
    user: User,
) -> dict[uuid.UUID, list[SalesProductComponent]]:
    """Every component in the workspace, grouped by product.

    One query for the whole catalog rather than one per level: a bundle's
    depth is unbounded and a catalog is not, so the flat load is both cheaper
    and constant in the graph's shape.
    """
    grouped: dict[uuid.UUID, list[SalesProductComponent]] = defaultdict(list)
    for component in SalesProductComponent.objects.filter(
        product__user=user
    ).select_related("recipe", "ingredient", "component_product"):
        grouped[component.product_id].append(component)
    return grouped


def product_closure(
    components_by_product: dict[uuid.UUID, list[SalesProductComponent]],
    root_id: uuid.UUID,
) -> set[uuid.UUID]:
    """The root and every product reachable from it through components."""
    seen = {root_id}
    pending = [root_id]
    while pending:
        for component in components_by_product.get(pending.pop(), ()):
            member_id = component.component_product_id
            if member_id is not None and member_id not in seen:
                seen.add(member_id)
                pending.append(member_id)
    return seen


def allocate_cents_by_weight(total_cents: int, weights: list[int]) -> list[int]:
    """Split integer cents exactly, in proportion to integer weights.

    Bundle revenue is an attributed view of the parent financial line, never
    another source of money. Returning integer shares whose sum is exactly the
    parent total keeps every product rollup reconcilable down to the cent.

    Each share is the difference between two cumulative floors, so the shares
    telescope to the total by construction and every step is exact integer
    arithmetic.
    """
    if not weights:
        return []
    if any(weight <= 0 for weight in weights):
        raise ValueError("Allocation weights must be above zero")

    absolute_total = abs(total_cents)
    weight_total = sum(weights)
    shares: list[int] = []
    cumulative_weight = 0
    previous_floor = 0
    for weight in weights:
        cumulative_weight += weight
        current_floor = absolute_total * cumulative_weight // weight_total
        shares.append(current_floor - previous_floor)
        previous_floor = current_floor
    if total_cents < 0:
        shares = [-share for share in shares]
    return shares


# `quantity` carries three decimal places, so scaling by a thousand makes
# every representable count an integer weight the allocator accepts.
_WEIGHT_SCALE = Decimal(1000)

MONEY_FIELDS = 5


@dataclass(frozen=True)
class BundleShare:
    """One member's view of the bundle unit that reached it."""

    product: SalesProduct
    units: Decimal
    cents: tuple[int, ...]
    depth: int


class BundleIndex:
    """The workspace's product-component graph, flattened once per request.

    Every read path that expands a bundle shares one of these, so a ledger of
    any size costs the same handful of queries: the graph, and — only when a
    bundle's value split has to fall back to cost — one costing load.
    """

    def __init__(
        self, user: User, components_by_product: dict[uuid.UUID, list[SalesProductComponent]]
    ) -> None:
        self._user = user
        self._components = components_by_product
        self._members: dict[uuid.UUID, list[SalesProductComponent]] = {}
        self._parents: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
        for product_id, rows in components_by_product.items():
            # `component_product_id` order is the order the member split
            # walked before bundles existed, so the cents land where they
            # always landed.
            members = sorted(
                (row for row in rows if row.component_product_id is not None),
                key=lambda row: row.component_product_id,
            )
            if members:
                self._members[product_id] = members
                for member in members:
                    self._parents[member.component_product_id].add(product_id)
        self._basis: dict[uuid.UUID, str] = {}
        # Costing is loaded only if some bundle's price rung fails, so a
        # workspace that prices its products never pays for it.
        self._costs: dict[uuid.UUID, int | None] | None = None
        self._cost_of = None

    @classmethod
    def for_user(cls, user: User) -> "BundleIndex":
        return cls(user, product_components_by_product(user))

    @property
    def bundle_ids(self) -> set[uuid.UUID]:
        return set(self._members)

    def is_bundle(self, product_id: uuid.UUID | None) -> bool:
        return product_id in self._members

    def closure(self, product_ids) -> set[uuid.UUID]:
        """Every product reachable from these through product components."""
        reached: set[uuid.UUID] = set()
        for product_id in product_ids:
            reached |= product_closure(self._components, product_id)
        return reached

    def bundles_containing(self, product_ids) -> set[uuid.UUID]:
        """Every bundle these products sit inside, however deeply nested."""
        found: set[uuid.UUID] = set()
        pending = list(product_ids)
        while pending:
            for parent_id in self._parents.get(pending.pop(), ()):
                if parent_id not in found:
                    found.add(parent_id)
                    pending.append(parent_id)
        return found

    def split_basis(self, product_id: uuid.UUID) -> str:
        """Which rung of the value ladder this bundle's split is standing on."""
        if product_id in self._basis:
            return self._basis[product_id]
        self._weights(product_id)
        return self._basis[product_id]

    def expand(
        self,
        product_id: uuid.UUID,
        units: Decimal,
        fields: list[int],
        *,
        depth: int = 0,
        path: tuple[uuid.UUID, ...] = (),
    ) -> list[BundleShare]:
        """Move a bundle's units and money down to the products inside it.

        Money is allocated level by level rather than through flattened
        weights: two levels may stand on different rungs of the value ladder,
        and a share of a share is not a share of the flattened whole.
        """
        members = self._members.get(product_id)
        if not members:
            return []
        weights = self._weights(product_id)
        allocations = [allocate_cents_by_weight(value, weights) for value in fields]
        walked = (*path, product_id)
        shares: list[BundleShare] = []
        for index, component in enumerate(members):
            member_units = units * component.quantity
            member_cents = tuple(allocation[index] for allocation in allocations)
            if self.is_bundle(component.component_product_id) and (
                component.component_product_id not in walked
            ):
                # A bundle inside a bundle keeps its units and hands its money
                # on, exactly as the outer one did. A box that reaches itself
                # stops here holding the money, rather than dropping it.
                shares.append(
                    BundleShare(
                        component.component_product,
                        member_units,
                        (0,) * MONEY_FIELDS,
                        depth + 1,
                    )
                )
                shares.extend(
                    self.expand(
                        component.component_product_id,
                        member_units,
                        list(member_cents),
                        depth=depth + 1,
                        path=walked,
                    )
                )
            else:
                shares.append(
                    BundleShare(
                        component.component_product,
                        member_units,
                        member_cents,
                        depth + 1,
                    )
                )
        return shares

    def _weights(self, product_id: uuid.UUID) -> list[int]:
        """Relative standalone value of each member, as integer weights.

        The ladder is chosen for the whole level, never per member: a price
        weight and a count weight are different magnitudes, and mixing them
        would silently invent a split nobody can explain.
        """
        members = self._members[product_id]
        prices = [member.component_product.sell_price_cents for member in members]
        if all(price > 0 for price in prices):
            self._basis[product_id] = "price"
            values = [
                member.quantity * price for member, price in zip(members, prices)
            ]
        else:
            costs = [self.unit_cost(member.component_product_id) for member in members]
            if all(cost is not None and cost > 0 for cost in costs):
                self._basis[product_id] = "cost"
                values = [
                    member.quantity * cost for member, cost in zip(members, costs)
                ]
            else:
                self._basis[product_id] = "count"
                values = [member.quantity for member in members]
        return [
            max(1, int((value * _WEIGHT_SCALE).to_integral_value(ROUND_HALF_UP)))
            for value in values
        ]

    def unit_cost(self, product_id: uuid.UUID) -> int | None:
        """One product's composition cost, the number its product page shows."""
        if self._costs is None:
            from .core import cost_walker

            self._costs = {}
            names = {
                component.component_product_id: component.component_product.name
                for rows in self._components.values()
                for component in rows
                if component.component_product_id is not None
            }
            self._cost_of = cost_walker(
                self._user, self._components, set(self._components), names
            )
        if product_id not in self._costs:
            cents, _ = self._cost_of(product_id, ())
            self._costs[product_id] = cents
        return self._costs[product_id]
