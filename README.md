# dsh-kid-tutor

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) bundle
that turns the harness into a tutor for a young kid — one that guides toward
answers instead of handing them over, and where every safety property is enforced
by the harness rather than promised by the model.

**Status: design.** Nothing runs yet. Read [DESIGN.md](DESIGN.md).

## Why

Consumer chatbots are built to answer. A nine-year-old learning Python, asking how
volcanoes work, or stuck in a video game needs something that asks back. And a
parent handing a kid an LLM needs guarantees a system prompt cannot give: what the
agent can touch, where it can browse, what it can say, how much it can spend, and a
trajectory the parent can read afterwards.

dsh is a good base because it is a [Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cordis-primer.md)
plugin tree: the persona, the tool registry, the sandbox policy, the model-call
stream, and the session log are all seams a bundle can attach to. This project is
that bundle, nothing more. It does not fork dsh.

## Principles

1. **The model is untrusted.** Its text and its tool calls are proposals. Anything
   the harness does not enforce does not exist.
2. **Fail closed.** If a guard cannot decide, the kid sees "ask me that again," not
   the unchecked output.
3. **Auditable trajectory.** dsh logs the model's path. This bundle logs the
   guards' path too — verdicts, suppressed messages, rejected tool calls — so the
   parent tunes from evidence.
4. **More fun than the alternative.** A restrictive tutor gets routed around. Hint
   ladders, visible machinery, and direct answers to curiosity questions are the
   product; refusal is not.
5. **Cordis-native.** Every behavior is a plugin contributing services, events, and
   reversible effects. Every knob is a config row a higher layer can patch.

## Roadmap

- **Phase 1** — bundle + profile deployed on a LAN host in the author's homelab,
  reached from the kid's laptop browser. Proves the guards and the audit loop.
- **Phase 2** — the final deployment model: dsh runs as a boot-time service under
  the parent's account on the kid's own laptop, web surface bound to loopback, the
  kid's own OS account opens it in a browser. No network exposure, no credential
  in the kid's hands.
- **Later** — transparency UI (context meter, "I packed up our chat" moments,
  tool-call cards) as the curriculum for how LLMs work.

## License

MIT
