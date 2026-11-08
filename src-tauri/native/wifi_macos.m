// Linked into PulseDrop itself so macOS privacy prompts belong to this app.
#import <Foundation/Foundation.h>
#import <CoreWLAN/CoreWLAN.h>
#import <CoreLocation/CoreLocation.h>
#import <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>

static CLLocationManager *locationManager;
static NSDictionary *failure(NSString *message) { return @{ @"error": message }; }
static BOOL locationAllowed(void) {
    CLAuthorizationStatus status = [CLLocationManager authorizationStatus];
    if (status == kCLAuthorizationStatusNotDetermined) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!locationManager) locationManager = [[CLLocationManager alloc] init];
            if (@available(macOS 10.15, *)) [locationManager requestWhenInUseAuthorization];
        });
    }
    return status == kCLAuthorizationStatusAuthorizedAlways || status == kCLAuthorizationStatusAuthorizedWhenInUse;
}
static NSString *privacyMessage = @"To show Wi-Fi names, allow Location for PulseDrop in System Settings → Privacy & Security → Location Services, then refresh Wi-Fi. macOS requires this for nearby Wi-Fi discovery.";
static BOOL validName(NSString *name) {
    return name.length > 0 && [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 32 &&
        [name rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location == NSNotFound;
}
static NSString *security(CWNetwork *network) {
    if ([network supportsSecurity:kCWSecurityWPA2Personal]) return @"WPA2";
    if ([network supportsSecurity:kCWSecurityNone]) return @"Open";
    return @"Other security";
}
static CWInterface *findInterface(NSString *name) {
    CWWiFiClient *client = [CWWiFiClient sharedWiFiClient];
    return name.length ? [client interfaceWithName:name] : [client interface];
}
static NSDictionary *perform(NSDictionary *request) {
    NSString *operation = request[@"operation"];
    if ([operation isEqualToString:@"available"]) return @{ @"available": @([CWWiFiClient interfaceNames].count > 0) };
    if (!locationAllowed()) return failure(privacyMessage);
    CWInterface *adapter = findInterface(request[@"interface"]);
    if (!adapter || !adapter.powerOn) return failure(@"No active Wi-Fi adapter. Enable Wi-Fi and refresh.");
    NSString *name = request[@"ssid"];
    NSString *bssid = request[@"bssid"];
    if ([operation isEqualToString:@"current"]) {
        return @{ @"active": @([adapter.ssid isEqualToString:name] && adapter.bssid.length && [adapter.bssid caseInsensitiveCompare:bssid] == NSOrderedSame) };
    }
    if ([operation isEqualToString:@"stop"]) {
        // A connection chosen in Settings is never disconnected by PulseDrop.
        if (adapter.ssid.length && (!([adapter.ssid isEqualToString:name]) ||
                [adapter.bssid caseInsensitiveCompare:bssid] != NSOrderedSame)) return @{};
        [adapter disassociate];
        NSString *previous = request[@"previous"];
        if (previous.length) {
            NSSet<CWNetwork *> *networks = [adapter scanForNetworksWithName:previous error:nil];
            CWNetwork *prior = networks.anyObject;
            // nil lets CoreWLAN use an existing keychain credential; PulseDrop
            // never reads passwords from other saved networks.
            if (!prior || ![adapter associateToNetwork:prior password:nil error:nil])
                return failure(@"Disconnected from the hotspot. Reconnect to your previous Wi-Fi in system settings.");
        }
        return @{};
    }
    NSError *error = nil;
    NSSet<CWNetwork *> *networks = [adapter scanForNetworksWithName:([operation isEqualToString:@"join"] ? name : nil) error:&error];
    if (!networks) return failure(@"Could not scan Wi-Fi. Enable Wi-Fi, allow Location for PulseDrop, then refresh.");
    if ([operation isEqualToString:@"scan"]) {
        NSMutableArray *results = [NSMutableArray array];
        for (CWNetwork *network in networks) {
            if (!validName(network.ssid) || !network.bssid.length) continue;
            [results addObject:@{ @"ssid": network.ssid, @"bssid": network.bssid,
                @"signal": @(MAX(0, MIN(100, (network.rssiValue + 100) * 2))),
                @"security": security(network), @"interface": adapter.interfaceName ?: @"" }];
        }
        [results sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"signal"] compare:a[@"signal"]]; }];
        if (results.count > 64) [results removeObjectsInRange:NSMakeRange(64, results.count - 64)];
        return @{ @"networks": results };
    }
    if ([operation isEqualToString:@"join"]) {
        CWNetwork *selected = nil;
        for (CWNetwork *network in networks) {
            if ([network.ssid isEqualToString:name] && [network supportsSecurity:kCWSecurityWPA2Personal] &&
                (!bssid.length || [network.bssid caseInsensitiveCompare:bssid] == NSOrderedSame)) {
                if (!selected || network.rssiValue > selected.rssiValue) selected = network;
            }
        }
        if (!selected || !selected.bssid.length) return failure(@"This WPA2 hotspot is no longer visible. Move closer and refresh Wi-Fi.");
        if ([adapter.ssid isEqualToString:name]) return failure(@"This device is already on that Wi-Fi. Choose I’ve connected · Find receiver below.");
        NSString *previous = adapter.ssid ?: @"";
        if (![adapter associateToNetwork:selected password:request[@"password"] error:&error]) {
            if (previous.length && (!adapter.ssid.length || [adapter.ssid isEqualToString:name])) {
                CWNetwork *prior = [adapter scanForNetworksWithName:previous error:nil].anyObject;
                if (!prior || ![adapter associateToNetwork:prior password:nil error:nil])
                    return failure(@"Could not join the hotspot or restore the previous Wi-Fi. Reconnect in system settings, check the hotspot password and retry.");
            }
            return failure(@"Could not join this hotspot. Check the Wi-Fi password, allow Location access and retry.");
        }
        if (![adapter.ssid isEqualToString:name] || !adapter.bssid.length || [adapter.bssid caseInsensitiveCompare:selected.bssid] != NSOrderedSame)
            return failure(@"Wi-Fi changed before the connection finished. Keep your chosen network, or retry.");
        return @{ @"interface": adapter.interfaceName, @"bssid": selected.bssid, @"previous": previous };
    }
    return failure(@"Unknown Wi-Fi action.");
}

char *pulsedrop_wifi_macos(const char *input) {
    @autoreleasepool {
        @try {
            NSData *data = [[NSString stringWithUTF8String:input] dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            NSDictionary *result = [request isKindOfClass:[NSDictionary class]] ? perform(request) : failure(@"Invalid Wi-Fi request.");
            NSData *response = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
            NSString *json = [[NSString alloc] initWithData:response encoding:NSUTF8StringEncoding];
            return strdup(json.UTF8String ?: "{\"error\":\"Wi-Fi response unavailable.\"}");
        } @catch (NSException *exception) {
            return strdup("{\"error\":\"Wi-Fi is unavailable. Check system Wi-Fi settings and retry.\"}");
        }
    }
}
void pulsedrop_wifi_macos_free(char *response) { free(response); }
