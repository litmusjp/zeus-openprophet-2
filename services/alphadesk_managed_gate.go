package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type managedApprovalGate struct {
	Required        bool
	Revision        int64
	WorkspaceID     string
	AssessmentKeyID string
}

var managedScopeUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func managedGateUnavailable(reason string, currentlyRequired bool) error {
	category := "response_validation"
	if currentlyRequired {
		category = "managed_review_required"
	}
	return &AlphaDeskUnavailableError{Reason: reason, Decision: "UNAVAILABLE", Category: category, Stage: "approval_gate"}
}

func parseManagedApprovalGate(doc map[string]any) (managedApprovalGate, bool, error) {
	var gate managedApprovalGate
	rawVersion, exists := doc["contract_version"]
	if !exists {
		if _, partial := doc["approval_gate"]; partial || doc["assessment_authority"] != nil {
			return gate, true, errors.New("partial managed assessment contract")
		}
		return gate, false, nil
	}
	if rawVersion != "managed-assessment-v1" || doc["assessment_authority"] != "assessment_only" {
		return gate, true, errors.New("unknown or malformed managed assessment contract")
	}
	if _, exists := doc["human_approval_required"]; exists {
		return gate, true, errors.New("managed receipt contains contradictory legacy human approval claim")
	}
	if _, exists := doc["execution_allowed"]; exists {
		return gate, true, errors.New("managed receipt contains contradictory legacy execution claim")
	}
	wire, ok := doc["approval_gate"].(map[string]any)
	if !ok {
		return gate, true, errors.New("managed approval gate is missing")
	}
	gate.Required, ok = wire["required"].(bool)
	if !ok {
		return gate, true, errors.New("managed gate required must be a boolean")
	}
	var revisionText string
	switch value := wire["revision"].(type) {
	case json.Number:
		revisionText = string(value)
	case string:
		return gate, true, errors.New("managed gate revision must be a JSON integer")
	default:
		return gate, true, errors.New("managed gate revision must be a JSON integer")
	}
	if strings.ContainsAny(revisionText, ".eE") {
		return gate, true, errors.New("managed gate revision must be an integer")
	}
	var revisionErr error
	gate.Revision, revisionErr = strconv.ParseInt(revisionText, 10, 64)
	if revisionErr != nil || gate.Revision <= 0 {
		return gate, true, errors.New("managed gate revision must be positive")
	}
	scope, ok := wire["scope"].(map[string]any)
	if !ok {
		return gate, true, errors.New("managed gate scope is missing")
	}
	gate.WorkspaceID, ok = scope["workspace_id"].(string)
	if !ok || !managedScopeUUID.MatchString(gate.WorkspaceID) {
		return gate, true, errors.New("managed gate workspace scope is invalid")
	}
	gate.AssessmentKeyID, ok = scope["assessment_key_id"].(string)
	if !ok || !managedScopeUUID.MatchString(gate.AssessmentKeyID) {
		return gate, true, errors.New("managed gate assessment key scope is invalid")
	}
	version, ok := doc["policy_version"].(string)
	stateText := "False"
	if gate.Required {
		stateText = "True"
	}
	if !ok || version != managedPolicyVersionBase(version)+fmt.Sprintf(":managed:%d:%s", gate.Revision, stateText) {
		return gate, true, errors.New("managed policy version does not bind the gate revision and state")
	}
	return gate, true, nil
}

func managedPolicyVersionBase(version string) string {
	marker := strings.LastIndex(version, ":managed:")
	if marker < 0 {
		return version
	}
	return version[:marker]
}

func sameManagedApprovalGate(a, b managedApprovalGate) bool {
	return a.Required == b.Required && a.Revision == b.Revision && a.WorkspaceID == b.WorkspaceID && a.AssessmentKeyID == b.AssessmentKeyID
}
