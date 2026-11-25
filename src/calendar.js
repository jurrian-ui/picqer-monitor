import { addDays, isoWeekday } from './time.js';

export class WorkCalendar {
  constructor({ workingDays = [1, 2, 3, 4, 5], closingDays = [] } = {}) {
    this.workingDays = new Set(workingDays);
    this.closingDays = new Set(closingDays);
  }

  isWorkingDay(dateStr) {
    return this.workingDays.has(isoWeekday(dateStr)) && !this.closingDays.has(dateStr);
  }

  /** Eerste werkdag op of na dateStr. */
  firstWorkingDayOnOrAfter(dateStr) {
    let d = dateStr;
    for (let i = 0; i < 366; i++) {
      if (this.isWorkingDay(d)) return d;
      d = addDays(d, 1);
    }
    throw new Error(`Geen werkdag gevonden binnen een jaar na ${dateStr}`);
  }

  /** Eerste werkdag strikt na dateStr. */
  nextWorkingDayAfter(dateStr) {
    return this.firstWorkingDayOnOrAfter(addDays(dateStr, 1));
  }

  /** Laatste werkdag strikt vóór dateStr. */
  previousWorkingDayBefore(dateStr) {
    let d = addDays(dateStr, -1);
    for (let i = 0; i < 366; i++) {
      if (this.isWorkingDay(d)) return d;
      d = addDays(d, -1);
    }
    throw new Error(`Geen werkdag gevonden binnen een jaar vóór ${dateStr}`);
  }
}
