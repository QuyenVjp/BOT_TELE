---
status: proposed
---

# Modular monolith as the initial architecture

Use a modular monolith with a worker, PostgreSQL and transactional outbox because payment/order/wallet invariants require strong transactional boundaries and the current scale/team does not justify distributed consistency. Split deployables only when measured load, isolation or ownership proves a boundary.

