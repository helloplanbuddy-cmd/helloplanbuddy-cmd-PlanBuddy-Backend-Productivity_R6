'use strict';

const express = require('express');
const { z } = require('zod');
const authController = require('../controllers/authController');
const { validate } = require('../middleware/validation');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const LoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password must be at most 72 characters'),
});

const RegisterSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password must be at most 72 characters'),
  name: z.string().min(1, 'Name is required').max(255, 'Name must be at most 255 characters'),
  phone: z.string().max(50).optional(),
  role: z.string().optional(),
});

const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

const LogoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

router.post('/register', authLimiter, validate(RegisterSchema), authController.register);
router.post('/login', authLimiter, validate(LoginSchema), authController.login);
router.post('/refresh', authLimiter, validate(RefreshTokenSchema), authController.refreshToken);
router.post('/logout', validate(LogoutSchema), authController.logout);
router.get('/me', authController.getCurrentUser);

module.exports = router;
