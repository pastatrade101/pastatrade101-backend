import type { PlanAccess } from '../membership/plan-access';
import { canAccess } from '../membership/plan-access';

// reportAccess.service — decides what a viewer can see for a report based on
// their plan. Free → preview only; Mid → daily/weekly full; Premium → all full
// (incl. monthly + Swahili). Admins always see full. The backend is the source
// of truth; the frontend only mirrors this.

export type ReportView = 'full' | 'preview';

interface ReportLike {
  report_type: string;
  audience: string;
  language: string;
}

const typeFeature = (reportType: string): string =>
  reportType === 'monthly' ? 'access_monthly_reports' : reportType === 'weekly' ? 'access_weekly_reports' : 'access_premium_reports';

export const resolveReportView = (access: PlanAccess, report: ReportLike): ReportView => {
  if (access.isAdmin) return 'full';
  if (report.audience === 'public' || report.report_type === 'preview') return 'full';
  const canType = canAccess(access, typeFeature(report.report_type));
  const canLang = report.language !== 'sw' || canAccess(access, 'access_swahili_reports');
  return canType && canLang ? 'full' : 'preview';
};

export const canExportReports = (access: PlanAccess): boolean => canAccess(access, 'access_export_reports');
