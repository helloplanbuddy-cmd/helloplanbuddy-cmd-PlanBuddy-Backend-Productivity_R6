-- Migration to create the seats table and add the seat_id to the bookings table.
BEGIN;

-- Create the seats table
CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seat_number VARCHAR(10) NOT NULL,
  is_booked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- Add the seat_id column to the bookings table
ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS seat_id UUID REFERENCES seats(id) ON DELETE RESTRICT;

-- Track migration
INSERT INTO schema_migrations (version, filename)
VALUES ('001', '001_create_seats_table.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;