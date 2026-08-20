import { and, desc, eq, gt, gte, lt, notExists, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { type gradeEnum, park, pitch, reservation, van } from "./schema/index.ts";

// Driver-agnostic: the app wires this to node-postgres, the harness to a gated
// pg-proxy driver. Both extend PgDatabase; nothing here depends on the schema
// generic.
// biome-ignore lint/suspicious/noExplicitAny: facade must accept any PgDatabase driver
export type Db = PgDatabase<any>;

type Grade = (typeof gradeEnum.enumValues)[number];

export function vansByGrade(db: Db, grade: Grade) {
  return db.select({ vans: sql<number>`count(*)` }).from(van).where(eq(van.grade, grade));
}

export function availabilityByDateRange(db: Db, parkId: number, from: string, to: string) {
  return db
    .select({ id: van.id, model: van.model, grade: van.grade })
    .from(van)
    .innerJoin(pitch, eq(pitch.id, van.pitchId))
    .where(
      and(
        eq(pitch.parkId, parkId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(reservation)
            .where(and(eq(reservation.vanId, van.id), lt(reservation.startDate, to), gt(reservation.endDate, from))),
        ),
      ),
    );
}

export function busiestModelsAllParks(db: Db) {
  return db
    .select({
      model: van.model,
      bookings: sql<number>`count(*)`,
      avgNights: sql<string>`avg(${reservation.endDate} - ${reservation.startDate})::numeric(10, 2)`,
    })
    .from(reservation)
    .innerJoin(van, eq(van.id, reservation.vanId))
    .groupBy(van.model)
    .orderBy(desc(sql`count(*)`));
}

export function gradeOccupancyByPark(db: Db, parkId: number, from: string, to: string) {
  return db
    .select({
      grade: van.grade,
      vans: sql<number>`count(distinct ${van.id})`,
      bookings: sql<number>`count(${reservation.id})`,
      nights: sql<number>`coalesce(sum(${reservation.endDate} - ${reservation.startDate}), 0)`,
    })
    .from(park)
    .innerJoin(pitch, eq(pitch.parkId, park.id))
    .innerJoin(van, eq(van.pitchId, pitch.id))
    .leftJoin(reservation, and(eq(reservation.vanId, van.id), gte(reservation.startDate, from), lt(reservation.startDate, to)))
    .where(eq(park.id, parkId))
    .groupBy(van.grade)
    .orderBy(van.grade);
}

export function parkBookings(db: Db, parkId: number, seasonStart: string, seasonEnd: string) {
  return db
    .select({
      bookings: sql<number>`count(*)`,
      first: sql<string>`min(${reservation.startDate})`,
      last: sql<string>`max(${reservation.endDate})`,
    })
    .from(reservation)
    .innerJoin(van, eq(van.id, reservation.vanId))
    .innerJoin(pitch, eq(pitch.id, van.pitchId))
    .where(and(eq(pitch.parkId, parkId), gte(reservation.startDate, seasonStart), lt(reservation.startDate, seasonEnd)));
}

export function vacuumReservation(db: Db) {
  return db.execute(sql`VACUUM (ANALYZE) reservation`);
}
