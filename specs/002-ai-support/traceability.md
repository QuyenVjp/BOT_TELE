# Requirement Traceability: AI Support Assistant

| Requirement | Tasks | Evidence |
|---|---|---|
| FR-201–FR-202 | T211, T215 | `ai-intent.test.ts` |
| FR-203 | T212, T216, T218 | grounding property tests |
| FR-204–FR-205 | T216, T220–T222 | read-only order/payment tests |
| FR-206 | T213, T217, T223 | safety/refusal tests |
| FR-207–FR-209 | T220–T226, T233 | FAQ/triage/handoff acceptance |
| FR-210 | T205, T213, T218 | response validation/security fixtures |
| FR-211–FR-213 | T205–T210, T219, T222 | provider/fallback contract |
| FR-214–FR-215 | T221, T224–T230 | Telegram UX/retention tests |
| SR-201–SR-204 | T202, T205–T209, T212–T218, T234–T235 | provider/redaction/BOLA |
| SR-205–SR-206 | T206, T213, T217, T237 | injection/failure recovery |
| SR-207–SR-208 | T227–T244 | retention and launch gates |
| SC-201–SC-204 | T206, T220–T221, T236, T239 | latency/fallback/provider evidence |
| SC-205–SC-206 | T213, T234–T237 | redaction/injection regression |
| SC-207–SC-208 | T228, T236 | budget/load/first-attempt evidence |

Coverage: 24/24 requirement/outcome groups map to tasks and test/evidence seams before implementation.
