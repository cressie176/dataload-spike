import { date, doublePrecision, index, integer, pgEnum, pgTable, serial, text } from "drizzle-orm/pg-core";

/**
 * van.grade is an enum, not text: grade is a small fixed set and a very likely
 * indexed field, so a 4-byte enum keeps that index small and cache-resident.
 * Regrades over time extend the enum (`ALTER TYPE ... ADD VALUE`), which is
 * also how the POC exercises a realistic schema-evolution migration.
 */
export const gradeEnum = pgEnum("grade", ["saver", "bronze", "silver", "gold", "platinum"]);

export const park = pgTable("park", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const pitch = pgTable(
  "pitch",
  {
    id: serial("id").primaryKey(),
    parkId: integer("park_id")
      .notNull()
      .references(() => park.id),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
  },
  (t) => [index("pitch_park_id_idx").on(t.parkId)],
);

export const van = pgTable(
  "van",
  {
    id: serial("id").primaryKey(),
    pitchId: integer("pitch_id")
      .notNull()
      .references(() => pitch.id),
    model: text("model").notNull(),
    grade: gradeEnum("grade").notNull(),
  },
  (t) => [index("van_pitch_id_idx").on(t.pitchId), index("van_grade_idx").on(t.grade)],
);

export const reservation = pgTable(
  "reservation",
  {
    id: serial("id").primaryKey(),
    vanId: integer("van_id")
      .notNull()
      .references(() => van.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
  },
  (t) => [index("reservation_van_id_idx").on(t.vanId), index("reservation_dates_idx").on(t.startDate, t.endDate)],
);
