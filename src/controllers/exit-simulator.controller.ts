import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { runSimulation, type PortfolioType, type SimulateInput, type SimulationMode } from '../services/exit-strategy/exitSimulator.service';
import { resolveUserAccess } from '../services/membership/plan-access';

// Portfolio Exit Simulator — private to each user. Portfolio values are never
// exposed to admin/global reports; saved simulations are filtered by user_id.

const PREMIUM_MODES: SimulationMode[] = ['profit_only', 'recover_capital', 'moonbag'];
const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const isPremium = async (userId: string): Promise<boolean> => {
  const access = await resolveUserAccess(userId);
  return access.isAdmin || access.plan.slug === 'premium';
};

const parseInput = (b: Record<string, unknown>, premium: boolean): SimulateInput => {
  let mode = ((b.simulation_mode as SimulationMode) || 'total_portfolio') as SimulationMode;
  // Mid plans: basic simulation, current risk only, no premium scenario modes.
  if (!premium && PREMIUM_MODES.includes(mode)) mode = 'total_portfolio';
  return {
    portfolio_value: Number(b.portfolio_value),
    original_capital: num(b.original_capital),
    portfolio_type: (b.portfolio_type as PortfolioType) || 'mixed',
    strategy_profile: (b.strategy_profile as string) || undefined,
    simulation_mode: mode,
    moonbag_percent: num(b.moonbag_percent),
    custom_risk_score: premium ? num(b.custom_risk_score) : null
  };
};

// POST /api/v1/exit-strategy/simulate
export const simulate = asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const portfolio_value = Number(b.portfolio_value);
  if (!Number.isFinite(portfolio_value) || portfolio_value <= 0) throw new AppError('Enter a valid portfolio value greater than 0.', 400);

  const premium = await isPremium(req.user!.sub);
  const result = await runSimulation(parseInput(b, premium));

  // Strip premium-only sections for mid so the response matches their access.
  if (!premium) {
    result.profit_info = null;
    result.recover_capital = null;
    result.moonbag = null;
    result.scenario_table = [];
  }
  return sendSuccess(res, 'Simulation computed successfully.', { ...result, is_premium: premium });
});

// POST /api/v1/exit-strategy/simulations/save  (premium only)
export const saveSimulation = asyncHandler(async (req: Request, res: Response) => {
  if (!(await isPremium(req.user!.sub))) throw new AppError('Saving simulations is a Premium feature.', 403);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const portfolio_value = Number(b.portfolio_value);
  if (!Number.isFinite(portfolio_value) || portfolio_value <= 0) throw new AppError('Enter a valid portfolio value greater than 0.', 400);

  // Recompute server-side — never trust client-supplied numbers.
  const input = parseInput(b, true);
  const sim = await runSimulation(input);

  const { data, error } = await supabase
    .from('exit_simulations')
    .insert({
      user_id: req.user!.sub,
      portfolio_type: input.portfolio_type,
      portfolio_value: sim.portfolio_value,
      original_capital: sim.original_capital,
      profit: sim.profit_info?.profit ?? null,
      strategy_profile: sim.strategy_profile,
      simulation_mode: sim.simulation_mode,
      exit_risk_score: sim.current_exit_risk_score,
      current_signal: sim.signal,
      suggested_exit_min_percent: sim.suggested_exit.min_percent,
      suggested_exit_max_percent: sim.suggested_exit.max_percent,
      suggested_exit_min_amount: sim.suggested_exit_amount.min,
      suggested_exit_max_amount: sim.suggested_exit_amount.max,
      remaining_min: sim.remaining_position.min,
      remaining_max: sim.remaining_position.max,
      result: sim,
      user_note: (b.user_note as string) || null
    })
    .select('*')
    .single();
  if (error) throw new AppError('Failed to save simulation.', 500, [error]);
  return sendSuccess(res, 'Simulation saved.', data);
});

// GET /api/v1/exit-strategy/simulations  (only the requesting user's own)
export const listSimulations = asyncHandler(async (req: Request, res: Response) => {
  const { data } = await supabase.from('exit_simulations').select('*').eq('user_id', req.user!.sub).order('created_at', { ascending: false }).limit(50);
  return sendSuccess(res, 'Saved simulations fetched.', { items: data ?? [] });
});

// DELETE /api/v1/exit-strategy/simulations/:id  (only your own)
export const deleteSimulation = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  const { error } = await supabase.from('exit_simulations').delete().eq('id', id).eq('user_id', req.user!.sub);
  if (error) throw new AppError('Failed to delete simulation.', 500, [error]);
  return sendSuccess(res, 'Simulation deleted.', { id });
});
