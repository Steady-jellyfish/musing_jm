/**
 * 인-프로세스 권한 확인 모듈
 *
 * member-db MCP 서버와 동일한 Mock 데이터를 사용합니다.
 * Phase 5에서 MCP 클라이언트 연결로 교체 예정.
 *
 * MCP 서버가 별도 프로세스로 실행되기 때문에,
 * HTTP 요청 처리 중에 MCP를 호출하려면 클라이언트 초기화가 필요합니다.
 * Phase 2에서는 같은 데이터를 인-프로세스 함수로 구현해 두고,
 * Phase 5에서 MCP 클라이언트로 일원화합니다.
 */

interface MemberPermissionConfig {
  allowedRoles: string[];
}

// member-db MCP 서버와 동일한 Mock 데이터 (단방향 참조: 여기가 source of truth)
const MEMBER_PERMISSIONS: Record<string, MemberPermissionConfig> = {
  "MBR-001": { allowedRoles: ["admin", "developer", "operator", "manager"] },
  "MBR-002": { allowedRoles: ["admin", "manager"] },
  HANWHA_LIFELAB: { allowedRoles: ["admin", "developer", "operator", "manager", "analyst"] },
};

export interface PermissionResult {
  allowed: boolean;
  reason: string;
}

/**
 * memberId와 role을 기준으로 ERP 문의 접근 권한을 확인합니다.
 */
export function checkPermission(memberId: string, role: string): PermissionResult {
  const config = MEMBER_PERMISSIONS[memberId];

  if (!config) {
    return {
      allowed: false,
      reason: `등록되지 않은 회원사입니다: ${memberId}`,
    };
  }

  if (!config.allowedRoles.includes(role)) {
    return {
      allowed: false,
      reason: `role '${role}'은 접근 권한이 없습니다. 허용 role: ${config.allowedRoles.join(", ")}`,
    };
  }

  return { allowed: true, reason: "접근 허용" };
}
