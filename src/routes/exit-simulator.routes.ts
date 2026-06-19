import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { simulate, saveSimulation, listSimulations, deleteSimulation } from '../controllers/exit-simulator.controller';

const router = Router();

// Portfolio Exit Simulator — Mid (basic) + Premium (full). Free is locked.
router.use(authenticate, requireFeature('access_exit_simulator'));

router.post('/simulate', simulate);
router.get('/simulations', listSimulations);
router.post('/simulations/save', saveSimulation);
router.delete('/simulations/:id', deleteSimulation);

export default router;
