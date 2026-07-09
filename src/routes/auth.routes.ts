import { Router } from 'express';
import { google, login, logout, me, register } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { googleAuthSchema, loginSchema, registerSchema } from '../schemas/auth.schema';

const router = Router();

router.post('/register', validate({ body: registerSchema }), register);
router.post('/login', validate({ body: loginSchema }), login);
router.post('/google', validate({ body: googleAuthSchema }), google);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

export default router;
