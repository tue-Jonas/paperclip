import { z } from "zod";
import { HEARTBEAT_RUN_STATUSES, ISSUE_STATUSES } from "../constants.js";

export const managementIssueListQuerySchema = z.object({
  status: z.enum(ISSUE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ManagementIssueListQuery = z.infer<typeof managementIssueListQuerySchema>;

export const managementRunListQuerySchema = z.object({
  status: z.enum(HEARTBEAT_RUN_STATUSES).optional(),
  activeOnly: z.coerce.boolean().optional().default(true),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ManagementRunListQuery = z.infer<typeof managementRunListQuerySchema>;

export const managementAnalyzerSnapshotQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 14).optional().default(24),
  evidenceLimit: z.coerce.number().int().min(1).max(25).optional().default(10),
});

export type ManagementAnalyzerSnapshotQuery = z.infer<typeof managementAnalyzerSnapshotQuerySchema>;
