package services

import (
	"encoding/json"
	"os"
	"testing"

	"prophet-trader/interfaces"
)

func TestAlphaDeskClientReadsManagedGateRequirementFromGoEnvironment(t *testing.T) {
	prior, existed := os.LookupEnv("ALPHADESK_REQUIRE_MANAGED_APPROVAL_GATE")
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv("ALPHADESK_REQUIRE_MANAGED_APPROVAL_GATE", prior)
		} else {
			_ = os.Unsetenv("ALPHADESK_REQUIRE_MANAGED_APPROVAL_GATE")
		}
	})
	if err := os.Setenv("ALPHADESK_REQUIRE_MANAGED_APPROVAL_GATE", "true"); err != nil {
		t.Fatal(err)
	}
	if client := NewAlphaDeskClientFromEnv(); !client.RequireManagedApprovalGate {
		t.Fatal("managed requirement flag was not consumed by the Go client")
	}
}

func TestManagedApprovalContractStrictValidation(t *testing.T) {
	good := map[string]any{
		"contract_version": "managed-assessment-v1", "assessment_authority": "assessment_only",
		"approval_gate": map[string]any{"required": false, "revision": json.Number("3"),
			"scope": map[string]any{"workspace_id": "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", "assessment_key_id": "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2"}},
		"policy_version": "base:managed:3:False",
	}
	gate, managed, err := parseManagedApprovalGate(good)
	if err != nil || !managed || gate.Required || gate.Revision != 3 || gate.WorkspaceID != "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1" || gate.AssessmentKeyID != "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2" {
		t.Fatalf("parse managed gate=%+v managed=%v err=%v", gate, managed, err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"wrong revision type": func(doc map[string]any) { doc["approval_gate"].(map[string]any)["revision"] = float64(3) },
		"revision overflow": func(doc map[string]any) {
			doc["approval_gate"].(map[string]any)["revision"] = json.Number("9223372036854775808")
		},
		"missing scope": func(doc map[string]any) {
			delete(doc["approval_gate"].(map[string]any)["scope"].(map[string]any), "workspace_id")
		},
		"wrong bool suffix":        func(doc map[string]any) { doc["policy_version"] = "base:managed:3:True" },
		"legacy contradiction":     func(doc map[string]any) { doc["human_approval_required"] = true },
		"unknown version":          func(doc map[string]any) { doc["contract_version"] = "managed-assessment-v9" },
		"partial managed contract": func(doc map[string]any) { delete(doc, "contract_version") },
	} {
		t.Run(name, func(t *testing.T) {
			doc := standaloneClone(mustJSON(t, good))
			mutate(doc)
			if _, _, err := parseManagedApprovalGate(doc); err == nil {
				t.Fatal("invalid managed contract accepted")
			}
		})
	}
	if _, _, err := parseManagedApprovalGate(map[string]any{"decision": "PASS"}); err != nil {
		t.Fatalf("legacy contract changed: %v", err)
	}
}

func TestManagedAssessmentAuditSerializesManagedGateWithoutLegacyFlags(t *testing.T) {
	a := interfaces.AlphaDeskAssessment{Decision: "PASS", ManagedContract: true, ManagedGateRevision: 3,
		ManagedGateWorkspaceID: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", ManagedGateAssessmentKeyID: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2"}
	wire, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	doc := standaloneClone(wire)
	if doc["contract_version"] != "managed-assessment-v1" || doc["assessment_authority"] != "assessment_only" || doc["approval_gate"] == nil {
		t.Fatalf("managed audit contract missing: %s", wire)
	}
	if _, exists := doc["human_approval_required"]; exists {
		t.Fatal("managed audit leaked legacy human approval flag")
	}
	if _, exists := doc["execution_allowed"]; exists {
		t.Fatal("managed audit leaked legacy execution flag")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
