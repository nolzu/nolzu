import { isDay, timesheetCsv, weekOf } from '@nolzu/protocol';
import { database } from '$lib/db.ts';
import { timesheetFor } from '$lib/timesheet.ts';
import type { RequestHandler } from './$types';

// The week grid as a file a spreadsheet reads. `?week=` takes any day of a week and the Monday is
// worked out from it, so a link can carry a Sunday. Anything else falls back to this week rather than
// answering an error, because the file is a download and a person cannot read an error in it.
export const GET: RequestHandler = ({ url }) => {
  const asked = url.searchParams.get('week');
  const week = asked !== null && isDay(asked) ? weekOf(asked) : undefined;
  const sheet = timesheetFor(database(), { week });
  return new Response(timesheetCsv(sheet), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="nolzu-timesheet-${sheet.week}.csv"`,
    },
  });
};
