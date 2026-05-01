"use strict";
// Copyright 2021-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageNeedsCustomValidType = messageNeedsCustomValidType;
exports.isProtovalidateDisabled = isProtovalidateDisabled;
exports.isProtovalidateRequired = isProtovalidateRequired;
exports.isLegacyRequired = isLegacyRequired;
const protobuf_1 = require("@bufbuild/protobuf");
const wkt_1 = require("@bufbuild/protobuf/wkt");
const minimal_validate_pb_js_1 = require("./gen/minimal-validate_pb.js");
/**
 * Returns true if the given message needs a ValidType. A message needs a ValidType
 * if one or more of the following conditions are true:
 * - A proto2 field has the `required` label
 * - A edition field has the feature `field_presence = LEGACY_REQUIRED`
 * - A field has the protovalidate `required` rule and not `ignore = IGNORE_ALWAYS`
 * - A message field (repeated, singular, or map value) needs a ValidType
 */
function messageNeedsCustomValidType(message, options) {
    function usesProtovalidateRequired(message, seen = new Set()) {
        seen.add(message.typeName);
        for (const field of message.fields) {
            if (isProtovalidateDisabled(field)) {
                continue;
            }
            if (isProtovalidateRequired(field)) {
                return true;
            }
            if (field.message && !seen.has(field.message.typeName)) {
                if (usesProtovalidateRequired(field.message, seen)) {
                    return true;
                }
            }
        }
        return false;
    }
    function usesLegacyRequired(message, seen = new Set()) {
        seen.add(message.typeName);
        for (const field of message.fields) {
            if (isLegacyRequired(field)) {
                return true;
            }
            if (field.message && !seen.has(field.message.typeName)) {
                if (usesLegacyRequired(field.message, seen)) {
                    return true;
                }
            }
        }
        return false;
    }
    return ((options.protovalidateRequired && usesProtovalidateRequired(message)) ||
        (options.legacyRequired && usesLegacyRequired(message)));
}
/**
 * Returns true if the field's protovalidate rules are (conditionally) disabled.
 *
 * Note that this function only applies to message fields (singular, repeated, map),
 * and always returns false for other field types.
 */
function isProtovalidateDisabled(descField) {
    if (descField.message === undefined) {
        return false;
    }
    const fieldRules = (0, protobuf_1.getOption)(descField, minimal_validate_pb_js_1.field);
    if (fieldRules.ignore == minimal_validate_pb_js_1.Ignore.ALWAYS) {
        return true;
    }
    const childRules = descField.fieldKind == "list" && fieldRules.type.case == "repeated"
        ? fieldRules.type.value.items
        : descField.fieldKind == "map" && fieldRules.type.case == "map"
            ? fieldRules.type.value.values
            : undefined;
    if (childRules) {
        return childRules.ignore == minimal_validate_pb_js_1.Ignore.ALWAYS;
    }
    return false;
}
/**
 * Returns true if the field is required by protovalidate.
 *
 * Note that this function only applies to message fields (singular, repeated, map),
 * and always returns false for other field types.
 */
function isProtovalidateRequired(descField) {
    if (!(0, protobuf_1.hasOption)(descField, minimal_validate_pb_js_1.field)) {
        return false;
    }
    const fieldRules = (0, protobuf_1.getOption)(descField, minimal_validate_pb_js_1.field);
    if (fieldRules.ignore === minimal_validate_pb_js_1.Ignore.ALWAYS) {
        return false;
    }
    return fieldRules.required;
}
/**
 * Returns true if the field has the proto2 `required` label, or the Edition
 * feature field_presence = LEGACY_REQUIRED.
 *
 * Note that this function only applies to singular message fields, and always
 * returns false for other fields.
 */
function isLegacyRequired(descField) {
    return (descField.fieldKind == "message" &&
        descField.presence == wkt_1.FeatureSet_FieldPresence.LEGACY_REQUIRED);
}
