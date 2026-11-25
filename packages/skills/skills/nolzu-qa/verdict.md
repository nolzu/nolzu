# How QA reports its verdict

One run of QA ends with one verdict. Only a parser reads it, from the line below, so a run that
leaves the line out is left for a person.

## The three verdicts

PASS means every `must` acceptance check has a `pass` row with its `Evidence:` line, and the
project's own checks, where it has any, ran and passed. A `should` check that failed or was not
reached does not stop a PASS, but section 1 of the report names it. Nothing unchecked counts as
passed. A brief with no levels is older than them: treat each of its checks as `must`.

FAIL means a check ran and did not hold, other than a `should` check. Name the one that mattered
most.

BLOCKED means QA could not get far enough to judge: the stack would not come up, a command is
missing, a credential is not there, a `must` check could not be seen, or the brief has no
acceptance check to test against. BLOCKED is a question for a person, not a result, so the reason
says what is needed rather than what is wrong.

Prefer FAIL over BLOCKED when a check failed: a BLOCKED over one awkward step hides a real failure
behind a question.

## The verdict line

Print it on a line of its own, with nothing before the word `NOLZU` and nothing after the reason.
It comes after the plain summary and before the line that closes the run, which is the last thing
a run prints:

    NOLZU: verdict: PASS

    NOLZU: verdict: FAIL <one line saying what failed>

    NOLZU: verdict: BLOCKED <one line saying what is needed>

The word is upper case. On FAIL and BLOCKED the reason follows on
that same line, after one space, with no line break in it. PASS takes no reason. No bold, no
bullet, no backticks and no heading on that line: the reader is a parser.

Write the line once. When the text above repeats it, for example in an echoed report, the last one
printed counts, so the last one has to be the verdict meant for the card. A FAIL or BLOCKED line
with no reason still counts as that verdict, and the card says the reason is missing.
