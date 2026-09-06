"""Typo tolerance for a name search — the twin of `apps/web/lib/fuzzy.ts`.

Every typed word must appear in the name, or sit within a small edit distance
of a word — or the start of a word — in it. "jarlic" finds garlic; "ga" still
only prefixes.
"""


def _allowance(length: int) -> int:
    return 0 if length < 4 else 1 if length < 8 else 2


def _distance(a: str, b: str, limit: int) -> int:
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left != right))
            )
        if min(current) > limit:
            return limit + 1
        previous = current
    return previous[len(b)]


def _near(token: str, word: str) -> bool:
    limit = _allowance(len(token))
    if limit == 0:
        return word.startswith(token)
    if _distance(token, word, limit) <= limit:
        return True
    return len(word) > len(token) and _distance(token, word[: len(token)], limit) <= limit


def fuzzy_matches(text: str, query: str) -> bool:
    """Every word of the folded `query` matches a word of the folded `text`."""
    words = text.split()
    return all(
        token in text or any(_near(token, word) for word in words)
        for token in query.split()
    )
