---
status: proposed
---

# One root admin mapped to an immutable Telegram user ID

The only root admin is the owner represented by `@Quyenvjp`, but authorization uses the numeric Telegram `user_id`, not a mutable username. The expected username is retained only as a consistency check and alert signal; no other admin can be added through the bot.

