#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Only the trusted Electron main process loads this addon. The service is fixed;
// no Keychain path, access group, synchronizable store or enumeration is exposed.
static NSString *const Service = @"build.caddi.browser.keys.v1";
static const size_t KeyLength = 32;
static void wipe(void *pointer, size_t count) {
    volatile uint8_t *cursor = pointer;
    while (count-- > 0) *cursor++ = 0;
}
static bool valid_identifier(const char *bytes, size_t length) {
    if (length < 1 || length > 64) return false;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)bytes[i];
        bool alphanumeric = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        if (!alphanumeric && (i == 0 || (c != '_' && c != '-'))) return false;
    }
    NSString *value = [[NSString alloc] initWithBytes:bytes length:length encoding:NSASCIIStringEncoding];
    NSSet *reserved = [NSSet setWithArray:@[@"__proto__", @"prototype", @"constructor", @"toString", @"valueOf",
        @"hasOwnProperty", @"isPrototypeOf", @"propertyIsEnumerable", @"__defineGetter__",
        @"__defineSetter__", @"__lookupGetter__", @"__lookupSetter__"]];
    return value != nil && ![reserved containsObject:value];
}
static bool read_ascii(napi_env env, napi_value value, char *out, size_t limit, size_t *length) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
    size_t count = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &count) != napi_ok || count == 0 || count > limit) return false;
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, value, out, limit + 1, &copied) != napi_ok || copied != count) return false;
    for (size_t i = 0; i < copied; i++) {
        unsigned char byte = (unsigned char)out[i];
        if (byte < 0x20 || byte > 0x7e) return false;
    }
    *length = copied;
    return true;
}
static OSStatus read_key(NSDictionary *base, uint8_t key[32]) {
    NSMutableDictionary *query = [base mutableCopy];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecSuccess) {
        if (result == NULL || CFGetTypeID(result) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)result) != (CFIndex)KeyLength)
            status = errSecDecode;
        else memcpy(key, CFDataGetBytePtr((CFDataRef)result), KeyLength);
    }
    if (result != NULL) CFRelease(result);
    return status;
}
static napi_value invalid(napi_env env) {
    napi_throw_type_error(env, "INVALID_ARGUMENT", "Invalid fixed native key request");
    return NULL;
}
static napi_value invoke(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 3) return invalid(env);
    char operation[8] = {0}, purpose[12] = {0}, identifier[65] = {0};
    size_t opLength = 0, purposeLength = 0, idLength = 0;
    if (!read_ascii(env, args[0], operation, 7, &opLength) ||
        !read_ascii(env, args[1], purpose, 11, &purposeLength) ||
        !read_ascii(env, args[2], identifier, 64, &idLength) || !valid_identifier(identifier, idLength)) return invalid(env);
    bool create = strcmp(operation, "create") == 0;
    bool get = strcmp(operation, "get") == 0;
    bool probe = strcmp(operation, "probe") == 0;
    bool remove = strcmp(operation, "delete") == 0;
    if ((!create && !get && !probe && !remove) ||
        (strcmp(purpose, "workspace") != 0 && strcmp(purpose, "pairing") != 0 &&
         strcmp(purpose, "owner-vault") != 0)) return invalid(env);
    napi_value response, statusValue;
    if (napi_create_object(env, &response) != napi_ok) return NULL;
    @autoreleasepool {
        NSString *account = [NSString stringWithFormat:@"%s:%s", purpose, identifier];
        LAContext *authentication = [[LAContext alloc] init];
        authentication.interactionNotAllowed = YES;
        NSDictionary *base = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: Service,
            (__bridge id)kSecAttrAccount: account,
            (__bridge id)kSecAttrSynchronizable: @NO,
            (__bridge id)kSecUseDataProtectionKeychain: @YES,
            (__bridge id)kSecUseAuthenticationContext: authentication,
        };
        uint8_t key[32] = {0};
        OSStatus status;
        if (remove) {
            status = SecItemDelete((__bridge CFDictionaryRef)base);
            if (status == errSecItemNotFound) status = errSecSuccess;
        } else {
            status = read_key(base, key);
            if (status == errSecItemNotFound && create) {
                status = SecRandomCopyBytes(kSecRandomDefault, KeyLength, key);
                if (status == errSecSuccess) {
                    NSMutableDictionary *attributes = [base mutableCopy];
                    attributes[(__bridge id)kSecValueData] = [NSData dataWithBytes:key length:KeyLength];
                    attributes[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
                    attributes[(__bridge id)kSecAttrLabel] = @"Caddi Browser development key";
                    status = SecItemAdd((__bridge CFDictionaryRef)attributes, NULL);
                    if (status == errSecSuccess || status == errSecDuplicateItem) {
                        wipe(key, sizeof(key));
                        status = read_key(base, key);
                    }
                }
            }
        }
        if (napi_create_int32(env, status, &statusValue) == napi_ok)
            napi_set_named_property(env, response, "status", statusValue);
        if (status == errSecSuccess && (get || create)) {
            napi_value buffer;
            if (napi_create_buffer_copy(env, KeyLength, key, NULL, &buffer) == napi_ok)
                napi_set_named_property(env, response, "key", buffer);
        }
        wipe(key, sizeof(key));
        [authentication invalidate];
    }
    return response;
}
// Saved logins. One generic-password item per login in the user's login keychain
// (the file-based keychain, never the iCloud-synced data protection keychain).
// The service is one fixed name per build; the account is the login ID.
// There is no enumeration, no other keychain and no authentication UI: a locked
// keychain or an item that would need a prompt is reported as a status instead.
static const size_t SecretLimit = 4096;
// Exactly one of the three build services. No test or other prefix is accepted by any build of this
// addon, so a packaged release can only ever reach its own build's items (and those of the other two
// Caddi builds by name, which share nothing else). Tests use an in-memory stand-in, never this addon.
static bool valid_service(const char *bytes, size_t length) {
    const char *services[] = {"build.caddi.logins.release", "build.caddi.logins.development", "build.caddi.logins.source"};
    for (size_t i = 0; i < 3; i++) if (length == strlen(services[i]) && strncmp(bytes, services[i], length) == 0) return true;
    return false;
}
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
// The user's default (login) keychain, only when it is already unlocked. Never unlocks it.
static OSStatus unlocked_login_keychain(SecKeychainRef *out) {
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &keychain);
    if (status == errSecSuccess && keychain == NULL) status = errSecNoDefaultKeychain;
    if (status != errSecSuccess) return status;
    SecKeychainStatus state = 0;
    status = SecKeychainGetStatus(keychain, &state);
    if (status == errSecSuccess && (state & kSecUnlockStateStatus) == 0) status = errSecInteractionNotAllowed;
    if (status != errSecSuccess) { CFRelease(keychain); return status; }
    *out = keychain;
    return errSecSuccess;
}
static NSMutableDictionary *login_query(NSString *service, NSString *account, SecKeychainRef keychain) {
    return [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account,
        (__bridge id)kSecMatchSearchList: @[(__bridge id)keychain],
        (__bridge id)kSecUseDataProtectionKeychain: @NO,
        (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail,
    } mutableCopy];
}
static napi_value login_item(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5];
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 3 || argc > 4) return invalid(env);
    char operation[8] = {0}, service[72] = {0}, identifier[65] = {0};
    size_t opLength = 0, serviceLength = 0, idLength = 0;
    if (!read_ascii(env, args[0], operation, 7, &opLength) ||
        !read_ascii(env, args[1], service, 71, &serviceLength) || !valid_service(service, serviceLength) ||
        !read_ascii(env, args[2], identifier, 64, &idLength) || !valid_identifier(identifier, idLength)) return invalid(env);
    bool set = strcmp(operation, "set") == 0, get = strcmp(operation, "get") == 0;
    bool exists = strcmp(operation, "exists") == 0, remove = strcmp(operation, "delete") == 0;
    if (!set && !get && !exists && !remove) return invalid(env);
    if (set != (argc == 4)) return invalid(env);
    void *secret = NULL;
    size_t secretLength = 0;
    if (set) {
        bool isBuffer = false;
        if (napi_is_buffer(env, args[3], &isBuffer) != napi_ok || !isBuffer ||
            napi_get_buffer_info(env, args[3], &secret, &secretLength) != napi_ok ||
            secretLength < 1 || secretLength > SecretLimit) return invalid(env);
    }
    napi_value response, statusValue;
    if (napi_create_object(env, &response) != napi_ok) return NULL;
    @autoreleasepool {
        NSString *serviceName = [[NSString alloc] initWithBytes:service length:serviceLength encoding:NSASCIIStringEncoding];
        NSString *account = [[NSString alloc] initWithBytes:identifier length:idLength encoding:NSASCIIStringEncoding];
        SecKeychainRef keychain = NULL;
        OSStatus status = unlocked_login_keychain(&keychain);
        CFTypeRef result = NULL;
        if (status == errSecSuccess) {
            NSMutableDictionary *query = login_query(serviceName, account, keychain);
            if (get) {
                query[(__bridge id)kSecReturnData] = @YES;
                query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
                status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
                if (status == errSecSuccess && (result == NULL || CFGetTypeID(result) != CFDataGetTypeID() ||
                    CFDataGetLength((CFDataRef)result) < 1 || CFDataGetLength((CFDataRef)result) > (CFIndex)SecretLimit)) status = errSecDecode;
            } else if (exists) {
                query[(__bridge id)kSecReturnAttributes] = @YES;
                query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
                status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
            } else if (remove) {
                query[(__bridge id)kSecReturnRef] = @YES;
                query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
                status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
                if (status == errSecSuccess && result != NULL) {
                    // Delete exactly the one item that matched this service and account.
                    status = SecItemDelete((__bridge CFDictionaryRef)@{ (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                        (__bridge id)kSecValueRef: (__bridge id)result });
                }
                if (status == errSecItemNotFound) status = errSecSuccess;
            } else {
                NSData *data = [NSData dataWithBytes:secret length:secretLength];
                NSMutableDictionary *probe = [query mutableCopy];
                probe[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
                status = SecItemCopyMatching((__bridge CFDictionaryRef)probe, NULL);
                if (status == errSecSuccess) {
                    status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)@{ (__bridge id)kSecValueData: data });
                } else if (status == errSecItemNotFound) {
                    NSMutableDictionary *attributes = [@{
                        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                        (__bridge id)kSecAttrService: serviceName,
                        (__bridge id)kSecAttrAccount: account,
                        (__bridge id)kSecUseKeychain: (__bridge id)keychain,
                        (__bridge id)kSecUseDataProtectionKeychain: @NO,
                        (__bridge id)kSecAttrLabel: @"Caddi saved login",
                        (__bridge id)kSecValueData: data,
                    } mutableCopy];
                    status = SecItemAdd((__bridge CFDictionaryRef)attributes, NULL);
                }
            }
        }
        if (napi_create_int32(env, status, &statusValue) == napi_ok) napi_set_named_property(env, response, "status", statusValue);
        if (status == errSecSuccess && get) {
            napi_value buffer;
            if (napi_create_buffer_copy(env, (size_t)CFDataGetLength((CFDataRef)result), CFDataGetBytePtr((CFDataRef)result), NULL, &buffer) == napi_ok)
                napi_set_named_property(env, response, "data", buffer);
        }
        if (result != NULL) CFRelease(result);
        if (keychain != NULL) CFRelease(keychain);
    }
    return response;
}
#pragma clang diagnostic pop

// A fresh check that the owner is present: Touch ID, or the account password, shown by macOS.
// Resolves true only when the system confirms it. Never cached, never reused.
typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    char reason[161];
    bool confirmed;
} PresenceRequest;
static void presence_execute(napi_env env, void *data) {
    (void)env;
    PresenceRequest *request = data;
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        NSError *error = nil;
        if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) { request->confirmed = false; return; }
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block bool confirmed = false;
        NSString *reason = [NSString stringWithUTF8String:request->reason];
        [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:reason reply:^(BOOL success, NSError *failure) {
            (void)failure;
            confirmed = success == YES;
            dispatch_semaphore_signal(done);
        }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)120 * NSEC_PER_SEC)) != 0) {
            [context invalidate];
            confirmed = false;
        }
        request->confirmed = confirmed;
    }
}
static void presence_complete(napi_env env, napi_status status, void *data) {
    PresenceRequest *request = data;
    napi_value value;
    napi_get_boolean(env, status == napi_ok && request->confirmed, &value);
    napi_resolve_deferred(env, request->deferred, value);
    napi_delete_async_work(env, request->work);
    free(request);
}
static napi_value user_presence(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1) return invalid(env);
    PresenceRequest *request = calloc(1, sizeof(PresenceRequest));
    if (request == NULL) return invalid(env);
    size_t length = 0;
    if (!read_ascii(env, args[0], request->reason, 160, &length) || length < 8) { free(request); return invalid(env); }
    napi_value promise, name;
    if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "caddi-presence", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_async_work(env, NULL, name, presence_execute, presence_complete, request, &request->work) != napi_ok ||
        napi_queue_async_work(env, request->work) != napi_ok) { free(request); return invalid(env); }
    return promise;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor descriptors[] = {
        {"invoke", NULL, invoke, NULL, NULL, NULL, napi_default, NULL},
        {"loginItem", NULL, login_item, NULL, NULL, NULL, napi_default, NULL},
        {"userPresence", NULL, user_presence, NULL, NULL, NULL, napi_default, NULL},
    };
    if (napi_define_properties(env, exports, 3, descriptors) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
