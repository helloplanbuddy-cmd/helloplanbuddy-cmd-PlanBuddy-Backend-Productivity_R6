-- Migration: Add seat availability constraint for overbooking prevention
-- Description: Prevent two bookings for the same seat on the same trip date
-- Fixes issue M-2: Booking seat race condition

BEGIN;

-- ─── Constraint: Prevent seat overbooking ────────────────────────────────────
-- Only one confirmed booking per seat per trip date
-- Allows multiple pending/cancelled bookings (they don't hold the seat)

ALTER TABLE bookings
ADD CONSTRAINT unique_seat_per_trip_date
UNIQUE (seat_id, trip_id, travel_date)
WHERE status IN ('confirmed', 'pending', 'paid');

-- Index for faster lookups
CREATE INDEX idx_bookings_seat_trip_date
ON bookings(seat_id, trip_id, travel_date)
WHERE status IN ('confirmed', 'pending', 'paid');

-- ─── Audit log ────────────────────────────────────────────────────────────────
INSERT INTO schema_migrations (name, description, applied_at)
VALUES (
  '001_add_seat_uniqueness_constraint',
  'Prevent overbooking by enforcing unique (seat_id, trip_id, travel_date) for active bookings',
  NOW()
);

COMMIT;
