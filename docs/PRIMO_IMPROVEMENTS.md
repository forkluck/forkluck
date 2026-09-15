# Primo product improvement acceptance

The September 14 comparison is the baseline. Infrastructure separation and
exact-cent/preview fixes are already deployed. Remaining delivery is sequenced
as recovery, draft continuity and calculations, aggregate kitchen reads, then
prompt editing. Each change uses synthetic fixtures; live checks do not save
business records.

## Turn recovery invariants

| Boundary | Expected behavior | Verification |
| --- | --- | --- |
| HTTP rejection before save | Restore unsent text, mentions and files; remove optimistic message; composer is the recovery path | Provider/composer tests and browser acceptance |
| Save succeeds; later HTTP or SSE failure | Acknowledge the user ID; keep the question and successful result cards; do not restore it as unsent | Route, real SDK stream, provider and browser tests |
| Lost response / unknown save outcome | Keep the question for retry with the same ID; do not claim it was unsent | Provider transport matrix; stable response identity route tests |
| Retry | Same user/answer identity; a newly typed draft is preserved | Browser acceptance and route identity tests |
| Repaired tool | A successful retry of the same input replaces its earlier failed status; a different recipe or period cannot mask it | Tool status matrix, real SDK repair and component tests |
| Terminal tool failure | One response status/retry; safe execution detail under What Primo checked | Component and browser tests |
| User Stop / timeout / disconnect | Distinct stopped vs failed status in the UI and persisted history; successful tools retained | Real SDK lifecycle matrix and component tests |
| Restored conversation | No terminal tool remains animated; recovery matches the live turn | Desktop/mobile/reopened browser acceptance |
| Conversation switch | A failed send cannot replace the selected conversation's messages; composer drafts remain scoped | Provider guard and existing draft lifetime tests |
| Authorization | Acknowledgement follows the owner-scoped durable save; foreign conversation is never acknowledged | Route and Django Primo tests |

No persistence shape, Django action contract, or deployment configuration changes
are required for turn recovery. The additive HTTP header is ignored by older
clients, so public app rollback remains compatible.

## Capability and editing invariants

- Authorized structured draft context survives real multi-turn and restored
  conversations. Scaling preserves instructions, source notes and review flags;
  ingredient changes preserve every unrelated field. Creation stays explicit.
- Supplied cookie inputs produce $0.75 ingredient cost, $1 variable cost,
  $1.50 contribution and 60% margin; a 20% ingredient increase produces $1.15
  variable cost and $2.875 exact / $2.88 minimum cent price. Cover missing inputs,
  margin vs markup, units and hypothetical vs stored facts.
- Top products and ingredient price changes agree with existing report periods,
  completeness and sales accounting. Empty data is distinct from zero; reads are
  tenant scoped; bundle revenue is never counted twice.
- Home starters yield a result or usable selection; ordinary search choices bind
  exact references. Prompt editing preserves mentions and attachments and has an
  explicit history policy.
- Run frontend/backend checks appropriate to the boundaries, private service
  tests/evaluations, public unconfigured acceptance, deploy to chefclaw, and replay
  the audit prompts in Chrome before declaring the product work complete.


| Boundary | Expected behavior | Verification |
| --- | --- | --- |
| Calculations | Missing yield is requested; supplied costs produce exact margin/markup and conservative currency rounding; zero costs stay finite | Public calculation matrix and private real-model follow-ups |
| Draft identity | Only stored owner-scoped results before the user turn; no browser tool-result authority; multi-draft choice; retries exclude replaced answer | Public tool tests and reopened browser draft sequence |
| Draft patch | Scaling and one-line edits preserve all other quantities, method, preparation/source/review notes; limits and duplicate indexes reject | Pure revision matrix and private live evaluation |
| Sales | Same Analytics period and bundle allocation, aggregate channels once; missing product revenue is excluded and disclosed; empty differs from zero | Public tool matrix and real report browser link |
| Prices | Tenant/active scope, kitchen midnight, pack changes, mass/volume units, zero baseline, missing/incompatible history, bounded output | Django endpoint and query-count tests, schema/route contract pins |
| Question edit | Same user ID/files; truncated following messages; stale snapshot rejected; unsent composer retained; Cancel does not write | Django transaction tests and component/real-stack browser tests |
| Generation lifecycle | Older retry/edit/follow-up/deleted-conversation stream cannot write a stale answer | Django generation guard matrix and route pairing tests |
| File lifecycle | Target files survive edit; discarded-tail files are marked deleted; invalid/foreign files roll back truncation | Django attachment/edit transaction tests |
| Unconfigured app | Public kitchen tools remain available and Home redirects to Analytics without gateway credentials | Existing unconfigured browser/build checks |

The generation token is stored in existing message metadata; no table or schema
migration. Deploy the additive private allowlist first, public app second;
rollback in reverse order. Live model evaluations are outcome checks, while
synthetic browser fixtures independently verify routing, persistence and UI.
