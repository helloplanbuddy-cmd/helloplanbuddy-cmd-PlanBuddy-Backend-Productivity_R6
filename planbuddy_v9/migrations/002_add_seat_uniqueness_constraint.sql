-- Migration: Add seat availability constraint for overbooking prevention
-- Description: Prevent two bookings for the same seat on the same trip date
-- Fixes issue M-2: Booking seat race condition

BEGIN;

-- ─── Constraint: Prevent seat overbooking ────────────────────────────────────
-- Only one confirmed booking per seat per trip date
-- Allows multiple pending/cancelled bookings (they don't hold the seat)

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_seat_trip_date
ON bookings(seat_id, trip_id, travel_date)
WHERE status IN ('confirmed', 'pending', 'paid');

-- ─── Migration tracking ───────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename)
VALUES ('002', '002_add_seat_uniqueness_constraint.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
