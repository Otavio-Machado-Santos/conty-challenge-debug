const civilDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function approvedCivilDay(approvedAt: string): string {
  const parts = civilDayFormatter.formatToParts(new Date(approvedAt));
  const part = (type: "year" | "month" | "day") => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
