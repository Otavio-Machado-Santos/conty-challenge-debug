const civilDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  era: "short",
});

export function isValidApprovedAt(approvedAt: string): boolean {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]|$)/.exec(approvedAt);
  if (!calendar) return false;
  const [, yearText, monthText, dayText] = calendar;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > monthDays[month - 1]!) return false;

  const instant = new Date(approvedAt);
  if (Number.isNaN(instant.getTime())) return false;
  const parts = civilDayFormatter.formatToParts(instant);
  const civilYear = Number(parts.find((part) => part.type === "year")!.value);
  const era = parts.find((part) => part.type === "era")!.value;
  return era === "AD" && civilYear <= 9999;
}

export function approvedCivilDay(approvedAt: string): string {
  const parts = civilDayFormatter.formatToParts(new Date(approvedAt));
  const part = (type: "year" | "month" | "day") => parts.find((value) => value.type === type)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
