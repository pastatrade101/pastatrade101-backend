import { loginUser, registerUser } from '../services/auth.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body.email, req.body.password, req.body.full_name);
  return sendSuccess(res, 'Registration successful.', result, 201);
});

export const login = asyncHandler(async (req, res) => {
  const result = await loginUser(req.body.email, req.body.password);
  return sendSuccess(res, 'Login successful.', result);
});

export const logout = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Logout successful.');
});

export const me = asyncHandler(async (req, res) => {
  return sendSuccess(res, 'Authenticated user fetched successfully.', req.user);
});
