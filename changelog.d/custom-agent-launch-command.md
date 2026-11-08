### Added
- Settings → Chat → New agents can save an exact single-line launch command per agent, shared
  across browsers and run on the selected PC without Ovis's launch-mode, model or effort defaults.
  Herdr runs the command during pane creation, without typing into an existing foreground
  process. Both the selected bridge and its running Herdr daemon must advertise support; older
  daemons and native Windows refuse before creation. A first message stays in the pending queue,
  Resume is unchanged, and uncertain launches are never retried. Commands are stored as plain
  text; keep secrets out of them.
