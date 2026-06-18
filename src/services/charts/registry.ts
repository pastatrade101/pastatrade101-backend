// Catalog of available charts (powers the searchable sidebar). `render` tells the
// frontend how to draw the payload returned by GET /charts/:key.
export type ChartRender = 'bar' | 'line' | 'heatmap' | 'index' | 'dca' | 'multiline';

export interface ChartDef {
  key: string;
  title: string;
  category: string;
  render: ChartRender;
  asset: string; // 'BTC' or 'MARKET'
  description: string;
}

export const CHART_REGISTRY: ChartDef[] = [
  {
    key: 'best-day-to-dca',
    title: 'Best Day To DCA',
    category: 'DCA',
    render: 'dca',
    asset: 'BTC',
    description: 'Simulate DCAing a fixed amount on each weekday over a date range, and compare the resulting ROI.'
  },
  {
    key: 'roi-yearly-overlay',
    title: 'ROI Overlay (Yearly)',
    category: 'ROI',
    render: 'multiline',
    asset: 'BTC',
    description: 'Each year’s cumulative ROI indexed to Jan 1, overlaid so you can compare years directly.'
  },
  {
    key: 'monthly-avg-roi',
    title: 'Monthly Average ROI',
    category: 'Seasonality',
    render: 'bar',
    asset: 'BTC',
    description: 'Average BTC return for each calendar month across all history.'
  },
  {
    key: 'annual-returns',
    title: 'Annual Returns',
    category: 'Returns',
    render: 'bar',
    asset: 'BTC',
    description: 'BTC year-over-year percentage returns.'
  },
  {
    key: 'monthly-returns',
    title: 'Monthly Returns',
    category: 'Returns',
    render: 'heatmap',
    asset: 'BTC',
    description: 'BTC monthly returns as a year × month heatmap.'
  },
  {
    key: 'running-roi',
    title: 'Running ROI',
    category: 'ROI',
    render: 'line',
    asset: 'BTC',
    description: 'Cumulative BTC ROI from a chosen start date.'
  },
  {
    key: 'altcoin-season',
    title: 'Altcoin Season Index',
    category: 'Altcoins',
    render: 'index',
    asset: 'MARKET',
    description: 'Share of the top-50 altcoins outperforming BTC over the last 30 days.'
  }
];

export const findChart = (key: string): ChartDef | undefined => CHART_REGISTRY.find((c) => c.key === key);
