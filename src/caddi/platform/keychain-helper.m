#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

// Development namespace only. No caller-supplied service, access group, search
// list, keychain path, enumeration operation, or password import is supported.
static NSString * const CaddiService = @"build.caddi.browser.keys.v1";
static const size_t CaddiKeyLength = 32;
static void wipe(void *memory, size_t count) {
    volatile unsigned char *cursor = memory;
    while (count-- > 0) *cursor++ = 0;
}

static int status_error(OSStatus status) {
    fprintf(stderr, "CADDI_KEYCHAIN_STATUS:%d\n", (int)status);
    return 70;
}
static int invalid_request(void) {
    fputs("CADDI_KEYCHAIN_PROTOCOL_ERROR\n", stderr);
    return 64;
}
static bool pipe_descriptor(int descriptor) {
    struct stat info;
    return fstat(descriptor, &info) == 0 && (S_ISFIFO(info.st_mode) || S_ISSOCK(info.st_mode));
}
static bool valid_identifier(NSString *value) {
    if (![value isKindOfClass:[NSString class]]) return false;
    NSData *encoded = [value dataUsingEncoding:NSASCIIStringEncoding allowLossyConversion:NO];
    if (encoded == nil || encoded.length < 1 || encoded.length > 64) return false;
    const unsigned char *bytes = encoded.bytes;
    for (NSUInteger i = 0; i < encoded.length; i++) {
        bool alphanumeric = (bytes[i] >= 'a' && bytes[i] <= 'z') ||
                            (bytes[i] >= 'A' && bytes[i] <= 'Z') ||
                            (bytes[i] >= '0' && bytes[i] <= '9');
        if (!alphanumeric && (i == 0 || (bytes[i] != '_' && bytes[i] != '-'))) return false;
    }
    NSArray<NSString *> *reserved = @[@"__proto__", @"prototype", @"constructor", @"toString", @"valueOf",
        @"hasOwnProperty", @"isPrototypeOf", @"propertyIsEnumerable", @"__defineGetter__",
        @"__defineSetter__", @"__lookupGetter__", @"__lookupSetter__"];
    return ![reserved containsObject:value];
}
static bool write_key(const uint8_t *key) {
    size_t offset = 0;
    while (offset < CaddiKeyLength) {
        ssize_t count = write(STDOUT_FILENO, key + offset, CaddiKeyLength - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}
static OSStatus read_key(NSDictionary *base, uint8_t *key) {
    NSMutableDictionary *query = [base mutableCopy];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecSuccess) {
        if (result == NULL || CFGetTypeID(result) != CFDataGetTypeID() ||
            CFDataGetLength((CFDataRef)result) != (CFIndex)CaddiKeyLength) {
            status = errSecDecode;
        } else {
            memcpy(key, CFDataGetBytePtr((CFDataRef)result), CaddiKeyLength);
        }
    }
    if (result != NULL) CFRelease(result);
    return status;
}

int main(int argc, const char *argv[]) {
    (void)argv;
    @autoreleasepool {
        // Prevent direct terminal/file key output and disable helper core dumps.
        if (argc != 1 || !pipe_descriptor(STDIN_FILENO) || !pipe_descriptor(STDOUT_FILENO)) return invalid_request();
        struct rlimit limit = {0, 0};
        if (setrlimit(RLIMIT_CORE, &limit) != 0) return invalid_request();
        signal(SIGPIPE, SIG_IGN);
        umask(0077);

        uint8_t requestBytes[1025];
        size_t used = 0;
        while (used < sizeof(requestBytes)) {
            ssize_t count = read(STDIN_FILENO, requestBytes + used, sizeof(requestBytes) - used);
            if (count < 0 && errno == EINTR) continue;
            if (count < 0) return invalid_request();
            if (count == 0) break;
            used += (size_t)count;
        }
        if (used == 0 || used > 1024) return invalid_request();
        NSError *jsonError = nil;
        NSData *input = [NSData dataWithBytes:requestBytes length:used];
        id parsed = [NSJSONSerialization JSONObjectWithData:input options:0 error:&jsonError];
        wipe(requestBytes, sizeof(requestBytes));
        if (jsonError != nil || ![parsed isKindOfClass:[NSDictionary class]]) return invalid_request();
        NSDictionary *request = parsed;
        NSSet *keys = [NSSet setWithArray:request.allKeys];
        if (![keys isEqualToSet:[NSSet setWithArray:@[@"version", @"operation", @"purpose", @"id"]]]) return invalid_request();
        NSNumber *version = request[@"version"];
        if (![version isKindOfClass:[NSNumber class]] ||
            CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() ||
            [version doubleValue] != 1.0) return invalid_request();
        NSString *operation = request[@"operation"];
        NSString *purpose = request[@"purpose"];
        NSString *identifier = request[@"id"];
        if (![@[@"create", @"get", @"probe", @"delete"] containsObject:operation] ||
            ![@[@"workspace", @"pairing", @"owner-vault"] containsObject:purpose] || !valid_identifier(identifier)) return invalid_request();

        LAContext *authentication = [[LAContext alloc] init];
        authentication.interactionNotAllowed = YES;
        NSDictionary *base = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: CaddiService,
            (__bridge id)kSecAttrAccount: [purpose stringByAppendingFormat:@":%@", identifier],
            (__bridge id)kSecAttrSynchronizable: @NO,
            (__bridge id)kSecUseDataProtectionKeychain: @YES,
            (__bridge id)kSecUseAuthenticationContext: authentication,
        };

        if ([operation isEqualToString:@"delete"]) {
            OSStatus status = SecItemDelete((__bridge CFDictionaryRef)base);
            [authentication invalidate];
            return (status == errSecSuccess || status == errSecItemNotFound) ? 0 : status_error(status);
        }

        uint8_t key[32] = {0};
        OSStatus status = read_key(base, key);
        if (status == errSecItemNotFound && [operation isEqualToString:@"create"]) {
            status = SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key);
            if (status == errSecSuccess) {
                NSMutableDictionary *attributes = [base mutableCopy];
                attributes[(__bridge id)kSecValueData] = [NSData dataWithBytes:key length:sizeof(key)];
                attributes[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
                attributes[(__bridge id)kSecAttrLabel] = @"Caddi Browser development key";
                status = SecItemAdd((__bridge CFDictionaryRef)attributes, NULL);
                // Never replace a race winner or return an uncommitted key.
                if (status == errSecSuccess || status == errSecDuplicateItem) {
                    wipe(key, sizeof(key));
                    status = read_key(base, key);
                }
            }
        }
        int result;
        if (status != errSecSuccess) result = status_error(status);
        else if ([operation isEqualToString:@"probe"]) result = 0;
        else result = write_key(key) ? 0 : 74;
        wipe(key, sizeof(key));
        [authentication invalidate];
        return result;
    }
}
