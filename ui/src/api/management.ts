import type {
  ManagementCompanyDetailResponse,
  ManagementCompanyListResponse,
  ManagementIssueListResponse,
  ManagementRunListResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const managementApi = {
  listCompanies(): Promise<ManagementCompanyListResponse> {
    return api.get("/management/companies");
  },

  getCompany(companyId: string): Promise<ManagementCompanyDetailResponse> {
    return api.get(`/management/companies/${companyId}`);
  },

  listCompanyIssues(
    companyId: string,
    params: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<ManagementIssueListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const qs = query.toString();
    return api.get(`/management/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },

  listCompanyRuns(
    companyId: string,
    params: { activeOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<ManagementRunListResponse> {
    const query = new URLSearchParams();
    if (params.activeOnly !== undefined) query.set("activeOnly", String(params.activeOnly));
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const qs = query.toString();
    return api.get(`/management/companies/${companyId}/runs${qs ? `?${qs}` : ""}`);
  },
};
