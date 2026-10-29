import { z } from "zod";

/** Team IDs as minted by the control plane (`team_<id>`). */
export const teamIdSchema = z.string().regex(/^team_[A-Za-z0-9_-]+$/);
