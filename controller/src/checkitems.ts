// The shape of an item the spec checker reports, which the checker's schema (agents.ts) and the
// acceptance that reads its items (acceptance.ts) share.

// The sections of a spec the checker judges, in the order the closing comment counts them.
export const sections = ['User stories', 'Decisions', 'Testing', 'Vocabulary', 'ADRs to write'] as const
export const verdicts = ['met', 'missing', 'deviates', 'untested'] as const
export const confidences = ['high', 'medium', 'low'] as const
