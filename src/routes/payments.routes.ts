import { Router } from 'express';
import { snippeWebhook } from '../controllers/payments.controller';

const router = Router();

// Public — authenticated by HMAC signature, not a JWT.
router.post('/webhook/snippe', snippeWebhook);

export default router;
