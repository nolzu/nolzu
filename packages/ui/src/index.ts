// The drag rules travel with the components, because the package export map is the only way out
// and the board route has to build the drag state from them.
export type { Allowed, Drag } from './board/drag.ts';
export { dropped, enterColumn, keepDrag, leaveColumn, lockReason, startDrag } from './board/drag.ts';
export type { DropOutcome, DropTarget, KeyStart, NearLimit, Refusal } from './board/drop.ts';
export { chainTarget, dropLabel, dropOutcome, dropTarget, goneSentence, keyStart, nearLimits, refuseDrop, refusalFromServer, RUNS_HERE, startsCommand, type Usage } from './board/drop.ts';
export { engineName, ranOn } from '@nolzu/protocol';

export { default as AddCardDialog } from './board/AddCardDialog.svelte';
export { addWords, type MyTickets } from './board/add-card.ts';
export { matchesFilter, waitingOnMe } from './board/filter.ts';
export { cardPill, liveOf, type Live, type Pill } from './board/quiet.ts';
export { answerHref, pickOption } from './board/answer.ts';
// The clock words of a card: a run's time, an age, a place in the queue. Now prints them as the board does.
export { age, elapsed } from './board/elapsed.ts';
export { ordinal } from './board/ordinal.ts';
export { default as WaitingToggle } from './board/WaitingToggle.svelte';
// The peek sheet, and the words it reads from the card's runs.
export { default as PeekSheet } from './board/PeekSheet.svelte';
export { ago, peekFacts, type PeekView, type TrailStep, trailSteps, trailTotal } from './board/peek.ts';
export type { BoardAction } from './board/keys.ts';
export { besideCard, boardKey, focusMove, shutColumns, visibleColumns } from './board/keys.ts';
// Every key in one list, read by the one handler and by the help.
export type { Binding, KeyActions, KeyRun, KeyScope, Stroke } from './keymap.ts';
export { capsOf, CARD_TABS, hintsOf, KEYS, liveKeys, scoped, tabKeys } from './keymap.ts';
export { default as Keyboard } from './Keyboard.svelte';
export { default as KeyCaps } from './KeyCaps.svelte';
export { default as StartConfirm } from './StartConfirm.svelte';
export { flipTheme, THEME_KEY } from './theme.ts';
export { default as Board } from './board/Board.svelte';
export { default as BoardCard } from './board/BoardCard.svelte';
export { default as BoardColumn } from './board/BoardColumn.svelte';
export { default as Overview } from './ticket/Overview.svelte';
export { default as FilesTab } from './ticket/FilesTab.svelte';
export { default as CommitComposer } from './ticket/CommitComposer.svelte';
export { default as PublishPanel } from './ticket/PublishPanel.svelte';
export { default as ChangesTab } from './ticket/ChangesTab.svelte';
export { default as ChangeGroups } from './ticket/ChangeGroups.svelte';
export { default as SendBackPanel } from './ticket/SendBackPanel.svelte';
export { default as TabBar } from './ticket/TabBar.svelte';
export { default as TicketActions } from './ticket/TicketActions.svelte';
export { default as DecisionPanel } from './ticket/DecisionPanel.svelte';
export { default as DeleteCardDialog } from './ticket/DeleteCardDialog.svelte';
export { default as PhaseStrip } from './ticket/PhaseStrip.svelte';
export { default as CardRecord } from './ticket/CardRecord.svelte';
export { parsePlan, type PlanStep, type PlanView, stepBodies } from './ticket/plan.ts';
export { numberedLines, type NumberedLine } from './ticket/patch.ts';
export { NEAR, placeComments } from './ticket/comments.ts';
export { decisionOf, type Decision, type DecisionKind, fixItOf, type FixIt, sendBackOf, type SendBack } from './ticket/decision.ts';
export { default as Markdown } from './Markdown.svelte';
export { default as RoleGlyph } from './RoleGlyph.svelte';
export { default as StatePill } from './StatePill.svelte';
export { default as Toast } from './Toast.svelte';
export { default as ToastHost } from './ToastHost.svelte';
export { dropToast, pushToast } from './toasts.ts';
export type { ToastItem, ToastKind, ToastRun } from './toasts.ts';
export { default as Dialog } from './Dialog.svelte';
export { closeOnBackdrop } from './backdrop.ts';
export { default as ConfirmTyped } from './ConfirmTyped.svelte';
export { default as Banner } from './Banner.svelte';
export { default as Button } from './Button.svelte';
export { default as Chip } from './Chip.svelte';
export { default as ErrorBox } from './ErrorBox.svelte';
export { default as Help } from './Help.svelte';
export { default as HelpTip } from './HelpTip.svelte';
export { default as InfoBox } from './InfoBox.svelte';
export { default as Skeleton } from './Skeleton.svelte';
export { default as Kbd } from './Kbd.svelte';
export { default as Switch } from './Switch.svelte';
export { default as SlotsMeter } from './SlotsMeter.svelte';
export { default as LaneChips } from './LaneChips.svelte';
export { default as CoachNote } from './CoachNote.svelte';
export { default as OptionButtons } from './OptionButtons.svelte';
export { default as LogTab } from './ticket/LogTab.svelte';
// The log's rows, for a screen that shows the last few of them, the countdown of a retry wait, and a run as the Log tab lists it.
export { clockTime, logRows, retryLine, type LogRow, type LogRun, type RetryWait, type TimedEvent } from './ticket/log.ts';
export { default as DiscussionTab } from './ticket/DiscussionTab.svelte';
export { default as SettingsTab } from './ticket/SettingsTab.svelte';
// The combined picker and the preset names, which Settings, Models draws too.
export { default as ModelPicker } from './ticket/ModelPicker.svelte';
export { presetLabel } from '@nolzu/protocol';
export { default as ReviewTab } from './ticket/ReviewTab.svelte';
export { default as PrLinks } from './ticket/PrLinks.svelte';
export { default as PrsTab } from './ticket/PrsTab.svelte';
export type { PrDiscussion, PrMessage } from './ticket/prs.ts';
export { ageWord, conventionalComments, DECISION_WORD, diffRounds, fixedLine, normaliseRound, parseRound, rereviewWhy, ROUND_LABELS } from './ticket/review.ts';
export type { FixedFinding, OpenFinding, RereviewFacts, ReviewBlock, RoundBlocks, RoundLabel, RoundRead, RoundsDiff } from './ticket/review.ts';
export { default as KnowledgeBrowser } from './KnowledgeBrowser.svelte';
export { default as QaPanels } from './ticket/QaPanels.svelte';
export { NOT_REPORTED, parseQaChecklist, QA_RESULTS, qaView } from './ticket/qa.ts';
export type { QaCheck, QaChecklist, QaInput, QaResult, QaRunInput, QaView, StackAction, StackButton, StackPanelView, StackStatusInput, VerdictPanelView } from './ticket/qa.ts';
export { changeIsOf, changeSource, fileBody, frontmatterDescription, knowledgeView, NO_KNOWLEDGE } from './knowledge.ts';
export type { KnowledgeChangeInput, KnowledgeChangeView, KnowledgeFileRow, KnowledgeInput, KnowledgeOpenFile, KnowledgeSource, KnowledgeView } from './knowledge.ts';
export { default as EnginesList } from './EnginesList.svelte';
export { canContinue, engineRows, type Detected, type EngineRow, type EveryPhaseHere, missingEngine } from './engines.ts';
export { projectView, type ProjectRow, type ProjectView } from './project.ts';
export { flowView } from './flow.ts';
// The shape the page hands the ticket actions, so the server that builds it and the component that
// draws it read one type.
export type { RunOnOffer } from './ticket/actions.ts';
// Retry or Stop for a card, so a key acts on the same card states the buttons do. `settle` holds a press
// until the snapshot shows the card moved, which Now's buttons follow too.
export { runView, settle } from './ticket/actions.ts';
