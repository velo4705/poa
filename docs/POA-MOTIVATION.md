# POA never stops porting

Porting is a search problem, not a yes/no verdict. POA's operating rule:

> "Impossible" is a statement about the current method, not the goal.
> Three genuinely different approaches is the floor, not the limit.

## Executable form: `poa.next_attempt`

When a stage fails, call `poa.next_attempt` with the **exact** blocker and the approaches already
tried. It returns:

- `neverStop: true` and a reframe of the blocker;
- at least three genuinely different mechanisms — decompose, change representation, search prior
  art, remove an assumption, minimal experiment, change tool, use an analogy — each with the
  smallest verifiable step and the evidence that would prove it;
- `forbiddenStops`: the lazy conclusions POA must not accept (e.g. "it's proprietary, therefore
  impossible", "Wine runs it, therefore it's ported");
- `genuineStopConditions`: the only valid reasons to pause — missing rights/permission, an explicit
  user constraint, a proven physical/mathematical limit, or an irreversible action needing approval.

## Practice

1. Name the blocker precisely ("`dotnet build` exits 1 with 1,376 `CS1061` errors on WPF events"),
   never "can't port this".
2. Generate a new mechanism, not a flag change. Re-running the same command with different
   parameters does not count as a new approach.
3. Take the smallest step and verify with observable evidence: exit code, output string, screenshot,
   byte digest, or a cited source.
4. If it fails, record why, remove that approach from the list, and generate another.
5. Declare degradations explicitly in the port report; never silently drop functionality to make a
   build green.

## Boundaries that remain real

"Never stop" does not mean "pretend". POA will not claim a runnable port without a runnable artifact,
will not use Wine or another compatibility layer as the port, and will not fabricate source from
machine code. Those are honesty constraints, not reasons to stop searching for a target-native path.
