import { Router } from 'express';
import { login, logout, me, register } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { loginSchema, registerSchema } from '../schemas/auth.schema';

const router = Router();

router.post('/register', validate({ body: registerSchema }), register);
router.post('/login', validate({ body: loginSchema }), login);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

export default router;
