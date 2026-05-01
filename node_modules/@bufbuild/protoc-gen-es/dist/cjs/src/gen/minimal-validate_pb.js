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
exports.field = exports.oneof = exports.IgnoreSchema = exports.Ignore = exports.MapRulesSchema = exports.RepeatedRulesSchema = exports.FieldRulesSchema = exports.OneofRulesSchema = exports.file_minimal_validate = void 0;
const codegenv2_1 = require("@bufbuild/protobuf/codegenv2");
const wkt_1 = require("@bufbuild/protobuf/wkt");
/**
 * Describes the file minimal-validate.proto.
 */
exports.file_minimal_validate = (0, codegenv2_1.fileDesc)("ChZtaW5pbWFsLXZhbGlkYXRlLnByb3RvEgxidWYudmFsaWRhdGUiHgoKT25lb2ZSdWxlcxIQCghyZXF1aXJlZBgBIAEoCCKkAQoKRmllbGRSdWxlcxIQCghyZXF1aXJlZBgZIAEoCBIkCgZpZ25vcmUYGyABKA4yFC5idWYudmFsaWRhdGUuSWdub3JlEi8KCHJlcGVhdGVkGBIgASgLMhsuYnVmLnZhbGlkYXRlLlJlcGVhdGVkUnVsZXNIABIlCgNtYXAYEyABKAsyFi5idWYudmFsaWRhdGUuTWFwUnVsZXNIAEIGCgR0eXBlIjgKDVJlcGVhdGVkUnVsZXMSJwoFaXRlbXMYBCABKAsyGC5idWYudmFsaWRhdGUuRmllbGRSdWxlcyI0CghNYXBSdWxlcxIoCgZ2YWx1ZXMYBSABKAsyGC5idWYudmFsaWRhdGUuRmllbGRSdWxlcypNCgZJZ25vcmUSFgoSSUdOT1JFX1VOU1BFQ0lGSUVEEAASGAoUSUdOT1JFX0lGX1pFUk9fVkFMVUUQARIRCg1JR05PUkVfQUxXQVlTEAM6TgoFb25lb2YSHS5nb29nbGUucHJvdG9idWYuT25lb2ZPcHRpb25zGIcJIAEoCzIYLmJ1Zi52YWxpZGF0ZS5PbmVvZlJ1bGVzUgVvbmVvZjpOCgVmaWVsZBIdLmdvb2dsZS5wcm90b2J1Zi5GaWVsZE9wdGlvbnMYhwkgASgLMhguYnVmLnZhbGlkYXRlLkZpZWxkUnVsZXNSBWZpZWxk", [wkt_1.file_google_protobuf_descriptor]);
/**
 * Describes the message buf.validate.OneofRules.
 * Use `create(OneofRulesSchema)` to create a new message.
 */
exports.OneofRulesSchema = (0, codegenv2_1.messageDesc)(exports.file_minimal_validate, 0);
/**
 * Describes the message buf.validate.FieldRules.
 * Use `create(FieldRulesSchema)` to create a new message.
 */
exports.FieldRulesSchema = (0, codegenv2_1.messageDesc)(exports.file_minimal_validate, 1);
/**
 * Describes the message buf.validate.RepeatedRules.
 * Use `create(RepeatedRulesSchema)` to create a new message.
 */
exports.RepeatedRulesSchema = (0, codegenv2_1.messageDesc)(exports.file_minimal_validate, 2);
/**
 * Describes the message buf.validate.MapRules.
 * Use `create(MapRulesSchema)` to create a new message.
 */
exports.MapRulesSchema = (0, codegenv2_1.messageDesc)(exports.file_minimal_validate, 3);
/**
 * @generated from enum buf.validate.Ignore
 */
var Ignore;
(function (Ignore) {
    /**
     * @generated from enum value: IGNORE_UNSPECIFIED = 0;
     */
    Ignore[Ignore["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: IGNORE_IF_ZERO_VALUE = 1;
     */
    Ignore[Ignore["IF_ZERO_VALUE"] = 1] = "IF_ZERO_VALUE";
    /**
     * @generated from enum value: IGNORE_ALWAYS = 3;
     */
    Ignore[Ignore["ALWAYS"] = 3] = "ALWAYS";
})(Ignore || (exports.Ignore = Ignore = {}));
/**
 * Describes the enum buf.validate.Ignore.
 */
exports.IgnoreSchema = (0, codegenv2_1.enumDesc)(exports.file_minimal_validate, 0);
/**
 * @generated from extension: optional buf.validate.OneofRules oneof = 1159;
 */
exports.oneof = (0, codegenv2_1.extDesc)(exports.file_minimal_validate, 0);
/**
 * @generated from extension: optional buf.validate.FieldRules field = 1159;
 */
exports.field = (0, codegenv2_1.extDesc)(exports.file_minimal_validate, 1);
