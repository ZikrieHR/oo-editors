/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

/*
 * NOTE(victor): DOCUMENT LOADING ARCHITECTURE
 * ============================================
 * This file patches ONLYOFFICE SDK for browser-based local editing. The loading
 * sequence MUST be deterministic to avoid race conditions.
 *
 * LOADING FLOW:
 * 1. offline-loader-proper.html creates DocsAPI editor
 * 2. Loader waits for Asc.asc_docs_api to exist (SDK fully initialized)
 * 3. Loader injects this file (common.js) into the iframe
 * 4. This file creates _commonJsReady Promise, starts waiting for SDK objects
 * 5. SDK calls onEndLoadFile() -> LocalStartOpen() when ready for document
 * 6. LocalStartOpen() (in desktop-stub.js) waits for _commonJsReady
 * 7. LocalStartOpen() calls DesktopOfflineAppDocumentEndLoad()
 * 8. DesktopOfflineAppDocumentEndLoad() also waits for _commonJsReady (guard)
 * 9. Document binary is loaded into SDK
 *
 * CRITICAL INVARIANTS:
 * - _commonJsReady MUST resolve before DesktopOfflineAppDocumentEndLoad executes
 * - SDK objects (AscCommon.baseEditorsApi, AscFonts.CFontFileLoader, etc.) MUST
 *   exist before their prototypes are patched
 * - The loader MUST wait for Asc.asc_docs_api before injecting common.js
 *
 * PREVIOUS BUG (2026-02):
 * setTimeout-based polling caused 30s delays when SDK loaded slowly. The loader
 * only checked for AscCommon (exists early) not asc_docs_api (exists when SDK
 * is actually ready). This caused common.js to start waiting for objects that
 * didn't exist yet, hitting the 30s timeout.
 *
 * FIX: Loader now waits for Asc.asc_docs_api. This file uses Promise-based
 * coordination instead of independent polling loops.
 */

"use strict";

// ============================================================================
// PROMISE-BASED SDK READINESS SYSTEM
// Replaces setTimeout polling with deterministic event-driven loading
// ============================================================================
(function(window) {
	var _resolveReady;
	var _commonJsReady = new Promise(function(resolve) { _resolveReady = resolve; });
	window._commonJsReady = _commonJsReady;

	// Track which overrides have completed
	var overrideStatus = {
		baseEditorsApi: false,
		fonts: false,
		sdk: false
	};

	function checkAllReady() {
		if (overrideStatus.baseEditorsApi && overrideStatus.fonts && overrideStatus.sdk) {
			console.log('[common.js] All SDK overrides complete - ready for document loading');
			_resolveReady();
		}
	}

	// Utility: Wait for an object property to exist, then call callback
	// Uses Object.defineProperty to intercept assignment (no polling)
	function waitForProperty(obj, prop, callback) {
		if (!obj) {
			console.error('[common.js] waitForProperty: obj is undefined for prop:', prop);
			return;
		}

		// If property already exists, call immediately
		if (obj[prop] !== undefined) {
			callback(obj[prop]);
			return;
		}

		// Use defineProperty to intercept when SDK assigns this property
		var value;
		var descriptor = Object.getOwnPropertyDescriptor(obj, prop);

		// If there's an existing descriptor, preserve its behavior
		if (descriptor && (descriptor.get || descriptor.set)) {
			// Property has getter/setter, poll briefly instead
			var checkInterval = setInterval(function() {
				if (obj[prop] !== undefined) {
					clearInterval(checkInterval);
					callback(obj[prop]);
				}
			}, 10);
			return;
		}

		Object.defineProperty(obj, prop, {
			get: function() { return value; },
			set: function(newValue) {
				value = newValue;
				// Restore normal property behavior after first set
				Object.defineProperty(obj, prop, {
					value: newValue,
					writable: true,
					configurable: true,
					enumerable: true
				});
				callback(newValue);
			},
			configurable: true,
			enumerable: true
		});
	}

	// Utility: Wait for nested property path (e.g., "AscCommon.baseEditorsApi")
	function waitForPath(pathStr, callback, maxWait) {
		maxWait = maxWait || 10000; // 10 second max wait (SDK should load faster)
		console.log('[common.js] waitForPath starting:', pathStr);
		var startTime = Date.now();
		var parts = pathStr.split('.');

		function resolve(obj, idx) {
			if (idx >= parts.length) {
				callback(obj);
				return;
			}

			var prop = parts[idx];

			if (obj && obj[prop] !== undefined) {
				resolve(obj[prop], idx + 1);
			} else if (obj) {
				// Use interval check for remaining path (simpler than nested defineProperty)
				var checkInterval = setInterval(function() {
					if (Date.now() - startTime > maxWait) {
						clearInterval(checkInterval);
						console.error('[common.js] Timeout waiting for:', pathStr, '- resolving anyway to prevent hang');
						// Mark all overrides as complete to prevent indefinite hang
						overrideStatus.baseEditorsApi = true;
						overrideStatus.fonts = true;
						overrideStatus.sdk = true;
						checkAllReady();
						return;
					}
					if (obj[prop] !== undefined) {
						clearInterval(checkInterval);
						resolve(obj[prop], idx + 1);
					}
				}, 20);
			} else {
				console.error('[common.js] Path resolution failed at:', parts.slice(0, idx).join('.'));
				// Resolve anyway to prevent indefinite hang
				overrideStatus.baseEditorsApi = true;
				overrideStatus.fonts = true;
				overrideStatus.sdk = true;
				checkAllReady();
			}
		}

		resolve(window, 0);
	}

	// NOTE(victor): The bundled SDK (sdk-all.js / sdk-all-min.js) minifies property
	// names: baseEditorsApi, CFontFileLoader, DocumentUrls don't exist under those
	// names. The overrides below are dead code against the minified SDK. The bundled
	// SDK has its own equivalent overrides (cell/sdk-all.js:18233, :18236, :18238),
	// and desktop-stub.js handles URL rewriting via LocalFileGetImageUrlCorrect.
	// Detect minified SDK and resolve immediately instead of waiting 10s to time out.
	var isMinifiedSdk = window.AscCommon && !window.AscCommon.baseEditorsApi;
	if (isMinifiedSdk) {
		console.log('[common.js] Minified SDK detected - skipping unminified overrides');
		overrideStatus.baseEditorsApi = true;
		overrideStatus.fonts = true;
		overrideStatus.sdk = true;
		checkAllReady();
	}

	// ========================================================================
	// OVERRIDE 1: Base Editors API (unminified SDK only)
	// ========================================================================
	!isMinifiedSdk && waitForPath('AscCommon.baseEditorsApi', function(baseEditorsApi) {
		console.log('[common.js] Applying baseEditorsApi overrides');

		baseEditorsApi.prototype._openChartOrLocalDocument = function() {
			if (this.isFrameEditor()) {
				return this._openEmptyDocument();
			}
		};

		baseEditorsApi.prototype.onEndLoadFile2 = baseEditorsApi.prototype.onEndLoadFile;
		baseEditorsApi.prototype.onEndLoadFile = function(result) {
			if (this.isFrameEditor() || !window["AscDesktopEditor"]) {
				return this.onEndLoadFile2(result);
			}

			if (this.isLoadFullApi && this.DocInfo && this._isLoadedModules()) {
				var self = this;
				this.asc_registerCallback('asc_onDocumentContentReady', function() {
					DesktopOfflineUpdateLocalName(Asc.editor || window.editor);
					// Delay plugin init slightly to ensure UI is ready
					Promise.resolve().then(function() {
						window["UpdateInstallPlugins"]();
					});
				});

				AscCommon.History.UserSaveMode = true;
				window["AscDesktopEditor"]["LocalStartOpen"]();
			}
		};

		baseEditorsApi.prototype["local_sendEvent"] = function() {
			return this.sendEvent.apply(this, arguments);
		};

		baseEditorsApi.prototype["asc_setLocalRestrictions"] = function(value, is_from_app) {
			this.localRestrintions = value;
			if (value !== Asc.c_oAscLocalRestrictionType.None)
				this.asc_addRestriction(Asc.c_oAscRestrictionType.View);
			else
				this.asc_removeRestriction(Asc.c_oAscRestrictionType.View);

			if (is_from_app)
				return;

			window["AscDesktopEditor"] && window["AscDesktopEditor"]["SetLocalRestrictions"] && window["AscDesktopEditor"]["SetLocalRestrictions"](value);
		};

		baseEditorsApi.prototype["asc_getLocalRestrictions"] = function() {
			if (undefined === this.localRestrintions)
				return Asc.c_oAscLocalRestrictionType.None;
			return this.localRestrintions;
		};

		baseEditorsApi.prototype["startExternalConvertation"] = function(type) {
			var params = "";
			try {
				params = JSON.stringify(this["getAdditionalSaveParams"]());
			} catch (e) {
				params = "";
			}
			this.sync_StartAction(Asc.c_oAscAsyncActionType.BlockInteraction, Asc.c_oAscAsyncAction.Waiting);
			window["AscDesktopEditor"]["startExternalConvertation"](type, params);
		};

		baseEditorsApi.prototype["endExternalConvertation"] = function() {
			this.sync_EndAction(Asc.c_oAscAsyncActionType.BlockInteraction, Asc.c_oAscAsyncAction.Waiting);
		};

		overrideStatus.baseEditorsApi = true;
		console.log('[common.js] baseEditorsApi overrides complete');
		checkAllReady();
	});

	// ========================================================================
	// OVERRIDE 2: Font Loading
	// ========================================================================
	!isMinifiedSdk && waitForPath('AscFonts.CFontFileLoader', function(CFontFileLoader) {
		console.log('[common.js] Applying font loading overrides');

		CFontFileLoader.prototype.LoadFontAsync = function(basePath, callback) {
			this.callback = callback;
			if (-1 !== this.Status)
				return true;

			this.Status = 2;

			var xhr = new XMLHttpRequest();
			xhr.fontFile = this;
			xhr.open('GET', "ascdesktop://fonts/" + this.Id, true);
			xhr.responseType = 'arraybuffer';

			if (xhr.overrideMimeType)
				xhr.overrideMimeType('text/plain; charset=x-user-defined');
			else
				xhr.setRequestHeader('Accept-Charset', 'x-user-defined');

			xhr.onload = function() {
				if (this.status !== 200) {
					this.fontFile.Status = 1;
					return;
				}

				this.fontFile.Status = 0;

				var fontStreams = AscFonts.g_fonts_streams;
				var streamIndex = fontStreams.length;
				if (this.response) {
					var data = new Uint8Array(this.response);
					fontStreams[streamIndex] = new AscFonts.FontStream(data, data.length);
				} else {
					fontStreams[streamIndex] = AscFonts.CreateFontData3(this.responseText);
				}

				this.fontFile.SetStreamIndex(streamIndex);

				if (null != this.fontFile.callback)
					this.fontFile.callback();
				if (this.fontFile["externalCallback"])
					this.fontFile["externalCallback"]();
			};

			xhr.send(null);
		};
		CFontFileLoader.prototype["LoadFontAsync"] = CFontFileLoader.prototype.LoadFontAsync;

		overrideStatus.fonts = true;
		console.log('[common.js] Font loading overrides complete');
		checkAllReady();
	});

	// ========================================================================
	// OVERRIDE 3: SDK Document URLs and Image Handling
	// ========================================================================
	!isMinifiedSdk && waitForPath('AscCommon.DocumentUrls', function(DocumentUrls) {
		// Also need CDocsCoApi for save overrides
		waitForPath('AscCommon.CDocsCoApi', function(CDocsCoApi) {
			console.log('[common.js] Applying SDK document/image overrides');

			var isOverrideDocumentUrls = true;

			function getCorrectImageUrl(path) {
				if (window["AscDesktopEditor"] && window["AscDesktopEditor"]["LocalFileGetImageUrlCorrect"])
					return window["AscDesktopEditor"]["LocalFileGetImageUrlCorrect"](path);
				return path;
			}

			if (isOverrideDocumentUrls) {
				var prot = DocumentUrls.prototype;
				prot.mediaPrefix = 'media/';
				prot.init = function(urls) {};
				prot.getUrls = function() { return this.urls; };
				prot.addUrls = function(urls) {};
				prot.addImageUrl = function(strPath, url) {};

				prot.getImageUrl = function(strPath) {
					if (0 === strPath.indexOf('theme'))
						return null;

					if (window.editor && window.editor.ThemeLoader && window.editor.ThemeLoader.ThemesUrl != "" && strPath.indexOf(window.editor.ThemeLoader.ThemesUrl) == 0)
						return null;

					var url = this.documentUrl + "/media/" + strPath;
					return getCorrectImageUrl(url);
				};

				prot.getImageLocal = function(_url) {
					var url = _url ? _url.replaceAll("%20", " ") : "";
					var _first = this.documentUrl + "/media/";
					if (0 === url.indexOf(_first))
						return url.substring(_first.length);

					if (window._ONLYOFFICE_FILE_HASH) {
						var mediaPattern = "/api/media/" + window._ONLYOFFICE_FILE_HASH + "/";
						var idx = url.indexOf(mediaPattern);
						if (idx !== -1)
							return url.substring(idx + mediaPattern.length);
					}

					if (window.editor && window.editor.ThemeLoader && 0 === url.indexOf(window.editor.ThemeLoader.ThemesUrlAbs)) {
						return url.substring(window.editor.ThemeLoader.ThemesUrlAbs.length);
					}

					return null;
				};

				prot.imagePath2Local = function(imageLocal) {
					if (imageLocal && this.mediaPrefix === imageLocal.substring(0, this.mediaPrefix.length))
						imageLocal = imageLocal.substring(this.mediaPrefix.length);
					return imageLocal;
				};

				prot.getUrl = function(strPath) {
					if (0 === strPath.indexOf('theme'))
						return null;

					if (window.editor && window.editor.ThemeLoader && window.editor.ThemeLoader.ThemesUrl != "" && strPath.indexOf(window.editor.ThemeLoader.ThemesUrl) == 0)
						return null;

					if (strPath == "Editor.xlsx") {
						var test = this.documentUrl + "/" + strPath;
						if (window["AscDesktopEditor"]["IsLocalFileExist"](test))
							return test;
						return undefined;
					}

					return this.documentUrl + "/media/" + strPath;
				};

				prot.getLocal = function(url) {
					return this.getImageLocal(url);
				};

				prot.isThemeUrl = function(sUrl) {
					return sUrl && (0 === sUrl.indexOf('theme'));
				};
			}

			// Image URL sending
			AscCommon.sendImgUrls = function(api, images, callback) {
				var _data = [];
				for (var i = 0; i < images.length; i++) {
					var _url = window["AscDesktopEditor"]["LocalFileGetImageUrl"](images[i]);
					_data[i] = { url: AscCommon.g_oDocumentUrls.getUrl(_url), path: _url };
				}
				callback(_data);
			};

			// Save changes
			CDocsCoApi.prototype.askSaveChanges = function(callback) {
				callback({ "saveLock": false });
			};

			CDocsCoApi.prototype.saveChanges = function(arrayChanges, deleteIndex, excelAdditionalInfo) {
				var count = arrayChanges.length;
				window["AscDesktopEditor"]["LocalFileSaveChanges"]((count > 100000) ? arrayChanges : arrayChanges.join("\",\""), deleteIndex, count);
			};

			// Watermark file dialog
			if (window['Asc'] && window['Asc']["CAscWatermarkProperties"]) {
				window['Asc']["CAscWatermarkProperties"].prototype["showFileDialog"] =
				window['Asc']["CAscWatermarkProperties"].prototype["asc_showFileDialog"] = function() {
					if (!this.Api || !this.DivId)
						return;

					var t = this.Api;
					var _this = this;

					window["AscDesktopEditor"]["OpenFilenameDialog"]("images", false, function(_file) {
						var file = _file;
						if (Array.isArray(file))
							file = file[0];
						if (!file)
							return;

						var url = window["AscDesktopEditor"]["LocalFileGetImageUrl"](file);
						var urls = [AscCommon.g_oDocumentUrls.getImageUrl(url)];

						t.ImageLoader.LoadImagesWithCallback(urls, function() {
							if (urls.length > 0) {
								_this.ImageUrl = urls[0];
								_this.Type = Asc.c_oAscWatermarkType.Image;
								_this.drawTexture();
								t.sendEvent("asc_onWatermarkImageLoaded");
							}
						});
					});
				};
			}

			// Bullet file dialog
			if (window["Asc"] && window["Asc"]["asc_CBullet"]) {
				window["Asc"]["asc_CBullet"].prototype["showFileDialog"] =
				window["Asc"]["asc_CBullet"].prototype["asc_showFileDialog"] = function() {
					var Api = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
					var _this = this;
					window["AscDesktopEditor"]["OpenFilenameDialog"]("images", false, function(_file) {
						var file = _file;
						if (Array.isArray(file))
							file = file[0];
						if (!file)
							return;

						var url = window["AscDesktopEditor"]["LocalFileGetImageUrl"](file);
						var urls = [AscCommon.g_oDocumentUrls.getImageUrl(url)];

						Api.ImageLoader.LoadImagesWithCallback(urls, function() {
							if (urls.length > 0) {
								_this.fillBulletImage(urls[0]);
								Api.sendEvent("asc_onBulletImageLoaded", _this);
							}
						});
					});
				};
			}

			// Drag and drop
			AscCommon.InitDragAndDrop = function(oHtmlElement, callback) {
				if ("undefined" != typeof(FileReader) && null != oHtmlElement) {
					oHtmlElement["ondragover"] = function(e) {
						e.preventDefault();
						e.dataTransfer.dropEffect = AscCommon.CanDropFiles(e) ? 'copy' : 'none';
						if (e.dataTransfer.dropEffect == "copy") {
							var editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
							editor.beginInlineDropTarget(e);
						}
						return false;
					};

					oHtmlElement["ondrop"] = function(e) {
						e.preventDefault();

						var editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
						editor.endInlineDropTarget(e);

						var _files = window["AscDesktopEditor"]["GetDropFiles"]();
						var countInserted = 0;
						if (0 !== _files.length) {
							var imageFiles = [];
							for (var i = 0; i < _files.length; i++) {
								if (window["AscDesktopEditor"]["IsImageFile"](_files[i])) {
									if (_files[i] === "")
										continue;

									var resImage = window["AscDesktopEditor"]["LocalFileGetImageUrl"](_files[i]);

									if (resImage) {
										imageFiles.push(AscCommon.g_oDocumentUrls.getImageUrl(resImage));
										++countInserted;
									}
									break;
								}
							}

							countInserted = imageFiles.length;
							if (0 !== countInserted)
								editor._addImageUrl(imageFiles);
						}

						if (0 === countInserted) {
							var htmlValue = e.dataTransfer.getData("text/html");
							if (htmlValue) {
								editor["pluginMethod_PasteHtml"](htmlValue);
								return;
							}

							var textValue = e.dataTransfer.getData("text/plain");
							if (textValue) {
								editor["pluginMethod_PasteText"](textValue);
								return;
							}
						}
					};
				}
			};

			overrideStatus.sdk = true;
			console.log('[common.js] SDK document/image overrides complete');
			checkAllReady();
		});
	});

})(window);

// NOTE(victor): common.js is compiled INTO sdk-all.js by Closure Compiler ADVANCED
// mode, which renames all dot-notation properties (g_oDocumentUrls, g_oIdCounter,
// OpenFileResult, sendPluginsInit, spellcheckGetLanguages, etc.). The compiled SDK
// at cell/sdk-all.js:18944-18968 has working versions of every function below with
// correctly renamed properties. When this file is injected separately by the loader,
// it overwrites those working definitions with versions that reference the original
// (non-existent) property names, causing TypeErrors. Skip all overrides when the
// compiled SDK is detected -- its built-in definitions are correct and complete.
var _isMinifiedSdk = window.AscCommon && !window.AscCommon.baseEditorsApi;

if (!_isMinifiedSdk) {

// ============================================================================
// DOCUMENT LOADING ENTRY POINT
// This function is called by the SDK via LocalStartOpen() when ready
// ============================================================================
var _documentLoadStarted = false;
window["DesktopOfflineAppDocumentEndLoad"] = function(_url, _data, _len) {
	// Guard against double loading
	if (_documentLoadStarted) {
		console.warn('[common.js] DesktopOfflineAppDocumentEndLoad already called, ignoring duplicate');
		return;
	}
	_documentLoadStarted = true;

	// Wait for all overrides to complete before proceeding
	window._commonJsReady.then(function() {
		console.log('[common.js] DesktopOfflineAppDocumentEndLoad executing (SDK ready)');

		var editor = Asc.editor || window.editor;
		if (!editor) {
			console.error('[common.js] No editor instance found!');
			return;
		}

		var effectiveUrl = _url;
		var overrideDocumentUrl = window._ONLYOFFICE_DOC_BASE_URL;

		if (overrideDocumentUrl) {
			if (overrideDocumentUrl.charAt(overrideDocumentUrl.length - 1) === "/")
				overrideDocumentUrl = overrideDocumentUrl.substring(0, overrideDocumentUrl.length - 1);
			AscCommon.g_oDocumentUrls.documentUrl = overrideDocumentUrl;
			effectiveUrl = overrideDocumentUrl;
		} else {
			AscCommon.g_oDocumentUrls.documentUrl = _url;
			var hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(AscCommon.g_oDocumentUrls.documentUrl);
			if (!hasScheme) {
				if (AscCommon.g_oDocumentUrls.documentUrl.indexOf("/") != 0)
					AscCommon.g_oDocumentUrls.documentUrl = "/" + AscCommon.g_oDocumentUrls.documentUrl;
				AscCommon.g_oDocumentUrls.documentUrl = "file://" + AscCommon.g_oDocumentUrls.documentUrl;
			}
			effectiveUrl = AscCommon.g_oDocumentUrls.documentUrl;
		}

		editor.setOpenedAt(Date.now());
		AscCommon.g_oIdCounter.m_sUserId = window["AscDesktopEditor"]["CheckUserId"]();

		if (_data === "") {
			editor.sendEvent("asc_onError", c_oAscError.ID.ConvertationOpenError, c_oAscError.Level.Critical);
			return;
		}

		var binaryArray = undefined;
		if (0 === _data.indexOf("binary_content://")) {
			var bufferArray = window["AscDesktopEditor"]["GetOpenedFile"](_data);
			if (bufferArray)
				binaryArray = new Uint8Array(bufferArray);
			else {
				editor.sendEvent("asc_onError", c_oAscError.ID.ConvertationOpenError, c_oAscError.Level.Critical);
				return;
			}
		}

		var file = new AscCommon.OpenFileResult();
		file.data = binaryArray ? binaryArray : getBinaryArray(_data, _len);
		file.bSerFormat = AscCommon.checkStreamSignature(file.data, AscCommon.c_oSerFormat.Signature);
		file.url = effectiveUrl;
		editor.openDocument(file);

		editor.asc_SetFastCollaborative(false);

		// Delay name update to allow editor UI to initialize
		// This prevents race conditions with UI components
		setTimeout(function() {
			DesktopOfflineUpdateLocalName(editor);
		}, 500);

		window["DesktopAfterOpen"](editor);

		editor.sendEvent("asc_onDocumentPassword", ("" != editor.currentPassword) ? true : false);
	});
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function DesktopOfflineUpdateLocalName(_api) {
	var _name = window["AscDesktopEditor"]["LocalFileGetSourcePath"]();

	var _ind1 = _name.lastIndexOf("\\");
	var _ind2 = _name.lastIndexOf("/");

	if (_ind1 == -1)
		_ind1 = 1000000;
	if (_ind2 == -1)
		_ind2 = 1000000;

	var _ind = Math.min(_ind1, _ind2);
	if (_ind != 1000000)
		_name = _name.substring(_ind + 1);

	_api.documentTitle = _name;

	// Delay asc_onDocumentName event to allow UI controllers to initialize
	// This prevents "Cannot read properties of undefined (reading 'setDocumentCaption')" error
	setTimeout(function() {
		_api.sendEvent("asc_onDocumentName", _name);
	}, 100);

	window["AscDesktopEditor"]["SetDocumentName"](_name);
}

window["NativeCorrectImageUrlOnCopy"] = function(url) {
	AscCommon.g_oDocumentUrls.getImageUrl(url);
};

window["NativeCorrectImageUrlOnPaste"] = function(url) {
	return window["AscDesktopEditor"]["LocalFileGetImageUrl"](url);
};

window["UpdateInstallPlugins"] = function() {
	var _pluginsTmp = JSON.parse(window["AscDesktopEditor"]["GetInstallPlugins"]());
	_pluginsTmp[0]["url"] = _pluginsTmp[0]["url"].split(" ").join("%20");
	_pluginsTmp[1]["url"] = _pluginsTmp[1]["url"].split(" ").join("%20");

	var _plugins = { "url": _pluginsTmp[0]["url"], "pluginsData": [] };
	for (var k = 0; k < 2; k++) {
		var _pluginsCur = _pluginsTmp[k];

		var _len = _pluginsCur["pluginsData"].length;
		for (var i = 0; i < _len; i++) {
			_pluginsCur["pluginsData"][i]["baseUrl"] = _pluginsCur["url"] + _pluginsCur["pluginsData"][i]["guid"].substring(4) + "/";
			_plugins["pluginsData"].push(_pluginsCur["pluginsData"][i]);

			if (_pluginsCur["pluginsData"][i]["onlyofficeScheme"]) {
				_pluginsCur["pluginsData"][i]["baseUrl"] = "onlyoffice://plugin/" + _pluginsCur["pluginsData"][i]["baseUrl"];
			}
		}
	}

	for (var i = 0; i < _plugins["pluginsData"].length; i++) {
		var _plugin = _plugins["pluginsData"][i];

		if (!_plugin["variations"]) {
			_plugins["pluginsData"].splice(i, 1);
			--i;
			continue;
		}

		var isSystem = false;
		for (var j = 0; j < _plugin["variations"].length; j++) {
			var _variation = _plugin["variations"][j];
			if (_variation["initDataType"] == "desktop") {
				isSystem = true;
				break;
			}
		}

		if (isSystem) {
			_plugins["pluginsData"].splice(i, 1);
			--i;
		}
	}

	var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;

	if (!window.IsFirstPluginLoad) {
		_editor.asc_registerCallback("asc_onPluginsReset", function() {
			if (_editor.pluginsManager) {
				_editor.pluginsManager.unregisterAll();
			}
		});

		window.IsFirstPluginLoad = true;
	}

	_editor.sendEvent("asc_onPluginsReset");
	window.g_asc_plugins.sendPluginsInit(_plugins);
};

window["DesktopOfflineAppDocumentSignatures"] = function(_json) {
	var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;

	_editor.signatures = [];

	var _signatures = [];
	if ("" != _json) {
		try {
			_signatures = JSON.parse(_json);
		} catch (err) {
			_signatures = [];
		}
	}

	var _count = _signatures["count"];
	var _data = _signatures["data"];
	var _sign;
	var _add_sign;

	var _images_loading = [];
	for (var i = 0; i < _count; i++) {
		_sign = _data[i];
		_add_sign = new window["AscCommon"].asc_CSignatureLine();

		_add_sign.guid = _sign["guid"];
		_add_sign.valid = _sign["valid"];
		_add_sign.image = (_add_sign.valid == 0) ? _sign["image_valid"] : _sign["image_invalid"];
		_add_sign.image = "data:image/png;base64," + _add_sign.image;
		_add_sign.signer1 = _sign["name"];
		_add_sign.id = i;
		_add_sign.date = _sign["date"];
		_add_sign.isvisible = window["asc_IsVisibleSign"](_add_sign.guid);
		_add_sign.correct();

		_editor.signatures.push(_add_sign);

		_images_loading.push(_add_sign.image);
	}

	_editor.ImageLoader.LoadImagesWithCallback(_images_loading, function() {
		if (this.WordControl)
			this.WordControl.OnRePaintAttack();
		else if (this._onShowDrawingObjects)
			this._onShowDrawingObjects();
	}, null);

	_editor.sendEvent("asc_onUpdateSignatures", _editor.asc_getSignatures(), _editor.asc_getRequestSignatures());
};

window["DesktopSaveQuestionReturn"] = function(isNeedSaved) {
	if (isNeedSaved) {
		var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
		_editor.asc_Save(false);
	} else {
		window.SaveQuestionObjectBeforeSign = null;
	}
};

window["OnNativeReturnCallback"] = function(name, obj) {
	var _api = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
	_api.sendEvent(name, obj);
};

window["asc_IsVisibleSign"] = function(guid) {
	var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;

	var isVisible = false;
	var _req = _editor.asc_getAllSignatures();
	for (var i = 0; i < _req.length; i++) {
		if (_req[i].id == guid) {
			isVisible = true;
			break;
		}
	}

	return isVisible;
};

window["asc_LocalRequestSign"] = function(guid, width, height, isView) {
	if (isView !== true && width === undefined) {
		width = 100;
		height = 100;
	}

	var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
	if (_editor.isRestrictionView())
		return;

	var _length = _editor.signatures.length;
	for (var i = 0; i < _length; i++) {
		if (_editor.signatures[i].guid == guid) {
			if (isView === true) {
				window["AscDesktopEditor"]["ViewCertificate"](_editor.signatures[i].id);
			}
			return;
		}
	}

	if (!_editor.isDocumentModified()) {
		_editor.sendEvent("asc_onSignatureClick", guid, width, height, window["asc_IsVisibleSign"](guid));
		return;
	}

	window.SaveQuestionObjectBeforeSign = { guid: guid, width: width, height: height };
	window["AscDesktopEditor"]["SaveQuestion"]();
};

window["DesktopAfterOpen"] = function(_api) {
	_api.asc_registerCallback("asc_onSignatureDblClick", function(guid, width, height) {
		window["asc_LocalRequestSign"](guid, width, height, true);
	});

	var langs = AscCommon.spellcheckGetLanguages();
	var langs_array = [];
	for (var item in langs) {
		if (!langs.hasOwnProperty(item))
			continue;
		langs_array.push(item);
	}

	_api.sendEvent('asc_onSpellCheckInit', langs_array);
};

function getBinaryArray(_data, _len) {
	return AscCommon.Base64.decode(_data, false, _len);
}

// Encryption support
(function() {
	// Wait for encryption API to be available
	function setupEncryption() {
		var _proto = (window.Asc && (Asc['asc_docs_api'] || Asc['spreadsheet_api'] || Asc['VisioEditorApi']));
		if (!_proto) {
			// Not available yet, will be set up when SDK loads
			return;
		}

		_proto.prototype["pluginMethod_OnEncryption"] = function(obj) {
			var _editor = window["Asc"]["editor"] ? window["Asc"]["editor"] : window.editor;
			switch (obj.type) {
				case "generatePassword":
					if ("" == obj["password"]) {
						AscCommon.History.UserSavedIndex = _editor.LastUserSavedIndex;

						if (window.editor)
							_editor.UpdateInterfaceState();
						else
							_editor.onUpdateDocumentModified(AscCommon.History.Have_Changes());

						_editor.LastUserSavedIndex = undefined;

						_editor.sendEvent("asc_onError", "There is no connection with the blockchain! End-to-end encryption mode is disabled.", c_oAscError.Level.NoCritical);
						if (window["AscDesktopEditor"])
							window["AscDesktopEditor"]["CryptoMode"] = 0;
						return;
					}

					_editor.currentDocumentInfoNext = obj["docinfo"];

					window["DesktopOfflineAppDocumentStartSave"](window.doadssIsSaveAs, obj["password"], true, obj["docinfo"] ? obj["docinfo"] : "");
					window["AscDesktopEditor"]["buildCryptedStart"]();
					break;

				case "getPasswordByFile":
					if ("" != obj["password"]) {
						_editor.currentPassword = obj["password"];

						if (window.isNativeOpenPassword) {
							window["AscDesktopEditor"]["NativeViewerOpen"](obj["password"]);
						} else {
							var _param = ("<m_sPassword>" + AscCommon.CopyPasteCorrectString(obj["password"]) + "</m_sPassword>");
							window["AscDesktopEditor"]["SetAdvancedOptions"](_param);
						}
					} else {
						this._onNeedParams(undefined, true);
					}
					break;

				case "encryptData":
				case "decryptData":
					AscCommon.EncryptionWorker.receiveChanges(obj);
					break;
			}
		};
	}

	// Try immediately and also when SDK loads
	setupEncryption();
	if (window._commonJsReady) {
		window._commonJsReady.then(setupEncryption);
	}
})();

AscCommon.getBinaryArray = getBinaryArray;

} // if (!_isMinifiedSdk)
