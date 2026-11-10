import { HolidayUtil, Solar } from 'lunar-javascript';
import { dayKey } from './scheduler';

export function isWorkday(date: Date, holidays: boolean): boolean {
  const holiday = holidays ? HolidayUtil.getHoliday(dayKey(date)) : null;
  return holiday ? holiday.isWork() : date.getDay() > 0 && date.getDay() < 6;
}
export function dateInfo(date: Date) {
  const lunar = Solar.fromDate(date).getLunar();
  return {
    lunarMonth: lunar.getMonth(), lunarDay: lunar.getDay(),
    lunar: lunar.toString(), term: lunar.getJieQi() || '',
    festivals: [...lunar.getFestivals(), ...Solar.fromDate(date).getFestivals()] as string[],
  };
}
export function birthdayMatches(b: { cal: string; m: number; d: number }, date: Date) {
  if (b.cal !== 'lunar') return date.getMonth() + 1 === b.m && date.getDate() === b.d;
  const lunar = Solar.fromDate(date).getLunar();
  // Ordinary lunar birthdays do not repeat in the leap month.
  return lunar.getMonth() === b.m && lunar.getDay() === b.d;
}
