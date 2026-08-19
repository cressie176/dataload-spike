CREATE TYPE "public"."grade" AS ENUM('saver', 'bronze', 'silver', 'gold', 'platinum');--> statement-breakpoint
CREATE TABLE "park" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pitch" (
	"id" serial PRIMARY KEY NOT NULL,
	"park_id" integer NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation" (
	"id" serial PRIMARY KEY NOT NULL,
	"van_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "van" (
	"id" serial PRIMARY KEY NOT NULL,
	"pitch_id" integer NOT NULL,
	"model" text NOT NULL,
	"grade" "grade" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pitch" ADD CONSTRAINT "pitch_park_id_park_id_fk" FOREIGN KEY ("park_id") REFERENCES "public"."park"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_van_id_van_id_fk" FOREIGN KEY ("van_id") REFERENCES "public"."van"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van" ADD CONSTRAINT "van_pitch_id_pitch_id_fk" FOREIGN KEY ("pitch_id") REFERENCES "public"."pitch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pitch_park_id_idx" ON "pitch" USING btree ("park_id");--> statement-breakpoint
CREATE INDEX "reservation_van_id_idx" ON "reservation" USING btree ("van_id");--> statement-breakpoint
CREATE INDEX "reservation_dates_idx" ON "reservation" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "van_pitch_id_idx" ON "van" USING btree ("pitch_id");--> statement-breakpoint
CREATE INDEX "van_grade_idx" ON "van" USING btree ("grade");