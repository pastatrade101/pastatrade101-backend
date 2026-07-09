import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { allowedOrigins, env } from './config/env';
import { errorMiddleware } from './middleware/error.middleware';
import { notFoundMiddleware } from './middleware/not-found.middleware';
import adminRoutes from './routes/admin.routes';
import adminMembershipRoutes from './routes/admin-membership.routes';
import adminReportRoutes from './routes/admin-report.routes';
import adminExitStrategyRoutes from './routes/admin-exit-strategy.routes';
import reportRoutes from './routes/report.routes';
import exitStrategyRoutes from './routes/exit-strategy.routes';
import exitSimulatorRoutes from './routes/exit-simulator.routes';
import logRegressionRoutes from './routes/log-regression.routes';
import adminLogRegressionRoutes from './routes/admin-log-regression.routes';
import overviewRoutes from './routes/overview.routes';
import derivativesRoutes from './routes/derivatives.routes';
import adminDerivativesRoutes from './routes/admin-derivatives.routes';
import macroRegimeRoutes from './routes/macro-regime.routes';
import earlyOpportunityRoutes from './routes/early-opportunity.routes';
import adminEarlyOpportunityRoutes from './routes/admin-early-opportunity.routes';
import altBtcBottomRoutes from './routes/alt-btc-bottom.routes';
import adminAltBtcBottomRoutes from './routes/admin-alt-btc-bottom.routes';
import icoIntelligenceRoutes from './routes/ico-intelligence.routes';
import adminIcoRoutes from './routes/admin-ico.routes';
import tokenRadarRoutes from './routes/token-radar.routes';
import adminTokenRadarRoutes from './routes/admin-token-radar.routes';
import altcoinBtcRoutes from './routes/altcoin-btc.routes';
import authRoutes from './routes/auth.routes';
import membershipRoutes from './routes/membership.routes';
import paymentsRoutes from './routes/payments.routes';
import plansRoutes from './routes/plans.routes';
import offersRoutes from './routes/offers.routes';
import youtubeRoutes from './routes/youtube.routes';
import btcRoutes from './routes/btc.routes';
import btcCycleRoutes from './routes/btc-cycle.routes';
import chartsRoutes from './routes/charts.routes';
import ecosystemsRoutes from './routes/ecosystems.routes';
import insightsRoutes from './routes/insights.routes';
import marketRoutes from './routes/market.routes';
import onchainRoutes from './routes/onchain.routes';
import riskRoutes from './routes/risk.routes';
import socialMetricsRoutes from './routes/social-metrics.routes';
import statsRoutes from './routes/stats.routes';
import watchlistRoutes from './routes/watchlist.routes';
import { sendSuccess } from './utils/api-response';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS.'));
    },
    credentials: true
  })
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// Stash the raw body so webhook handlers (Snippe) can verify HMAC signatures
// against the exact bytes that were signed.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    }
  })
);
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) =>
  sendSuccess(res, 'API is healthy.', { uptime: process.uptime(), environment: env.NODE_ENV })
);

// All product routes are versioned under /api/v1 per the SRS.
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/market', marketRoutes);
app.use('/api/v1/btc', btcRoutes);
app.use('/api/v1/btc-cycle', btcCycleRoutes);
app.use('/api/v1/altcoin-btc', altcoinBtcRoutes);
app.use('/api/v1/charts', chartsRoutes);
app.use('/api/v1/ecosystems', ecosystemsRoutes);
app.use('/api/v1/risk', riskRoutes);
app.use('/api/v1/onchain', onchainRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/exit-strategy', exitStrategyRoutes);
app.use('/api/v1/exit-strategy', exitSimulatorRoutes);
app.use('/api/v1/charts/log-regression', logRegressionRoutes);
app.use('/api/v1/admin', adminLogRegressionRoutes);
app.use('/api/v1/admin', adminDerivativesRoutes);
app.use('/api/v1/admin', adminEarlyOpportunityRoutes);
app.use('/api/v1/admin', adminAltBtcBottomRoutes);
app.use('/api/v1/admin', adminIcoRoutes);
app.use('/api/v1/admin', adminTokenRadarRoutes);
app.use('/api/v1/overview', overviewRoutes);
app.use('/api/v1/derivatives', derivativesRoutes);
app.use('/api/v1/macro-regime', macroRegimeRoutes);
app.use('/api/v1/early-opportunity-radar', earlyOpportunityRoutes);
app.use('/api/v1/alt-btc-bottom-radar', altBtcBottomRoutes);
app.use('/api/v1/ico-projects', icoIntelligenceRoutes);
app.use('/api/v1/token-radar', tokenRadarRoutes);
app.use('/api/v1/social-metrics', socialMetricsRoutes);
app.use('/api/v1/watchlists', watchlistRoutes);
app.use('/api/v1/plans', plansRoutes);
app.use('/api/v1/offers', offersRoutes);
app.use('/api/v1/youtube', youtubeRoutes);
app.use('/api/v1/stats', statsRoutes);
app.use('/api/v1/insights', insightsRoutes);
app.use('/api/v1/me', membershipRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin', adminMembershipRoutes);
app.use('/api/v1/admin', adminReportRoutes);
app.use('/api/v1/admin', adminExitStrategyRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
