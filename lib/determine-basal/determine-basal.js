/*
  Determine Basal

  Released under MIT license. See the accompanying LICENSE.txt file for
  full terms and conditions

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/


var round_basal = require('../round-basal')

// Rounds value to 'digits' decimal places
function round(value, digits)
{
    if (! digits) { digits = 0; }
    var scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

// we expect BG to rise or fall at the rate of BGI,
// adjusted by the rate at which BG would need to rise /
// fall to get eventualBG to target over DIA/2 hours
function calculate_expected_delta(dia, target_bg, eventual_bg, bgi) {
    // (hours * mins_per_hour) / 5 = how many 5 minute periods in dia/2
    var dia_in_5min_blocks = (dia/2 * 60) / 5;
    var target_delta = target_bg - eventual_bg;
    var expectedDelta = round(bgi + (target_delta / dia_in_5min_blocks), 1);
    return expectedDelta;
}


function convert_bg(value, profile)
{
    if (profile.out_units == "mmol/L")
    {
        return round(value / 18, 1).toFixed(1);
    }
    else
    {
        return Math.round(value);
    }
}

var determine_basal = function determine_basal(glucose_status, currenttemp, iob_data, profile, autosens_data, meal_data, tempBasalFunctions, microBolusAllowed, reservoir_data) {
    var rT = {}; //short for requestedTemp

    var deliverAt = new Date();

    if (typeof profile === 'undefined' || typeof profile.current_basal === 'undefined') {
        rT.error ='Error: could not get current basal rate';
        return rT;
    }
    var basal = profile.current_basal;
    if (typeof autosens_data !== 'undefined' ) {
        basal = profile.current_basal * autosens_data.ratio;
        basal = round_basal(basal, profile);
        if (basal != profile.current_basal) {
            process.stderr.write("Adjusting basal from "+profile.current_basal+" to "+basal+"; ");
        }
    }

    var bg = glucose_status.glucose;
    if (bg < 39) {  //Dexcom is in ??? mode or calibrating
        rT.reason = "CGM is calibrating or in ??? state";
        if (basal <= currenttemp.rate * 1.2) { // high temp is running
            rT.reason += "; setting current basal of " + basal + " as temp";
            rT.deliverAt = deliverAt;
            rT.temp = 'absolute';
            return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        } else { //do nothing.
            rT.reason += ", temp " + currenttemp.rate + " <~ current basal " + basal + "U/hr";
            return rT;
        }
    }

    var max_iob = profile.max_iob; // maximum amount of non-bolus IOB OpenAPS will ever deliver

    // if target_bg is set, great. otherwise, if min and max are set, then set target to their average
    var target_bg;
    var min_bg;
    var max_bg;
    if (typeof profile.min_bg !== 'undefined') {
            min_bg = profile.min_bg;
    }
    if (typeof profile.max_bg !== 'undefined') {
            max_bg = profile.max_bg;
    }
    if (typeof profile.target_bg !== 'undefined') {
        target_bg = profile.target_bg;
    } else {
        if (typeof profile.min_bg !== 'undefined' && typeof profile.max_bg !== 'undefined') {
            target_bg = (profile.min_bg + profile.max_bg) / 2;
        } else {
            rT.error ='Error: could not determine target_bg';
            return rT;
        }
    }

    // adjust min, max, and target BG for sensitivity, such that 50% increase in ISF raises target from 100 to 120
    if (typeof autosens_data !== 'undefined' && profile.autosens_adjust_targets) {
      if (profile.temptargetSet) {
        process.stderr.write("Temp Target set, not adjusting with autosens; ");
      } else {
        // with a target of 100, default 0.7-1.2 autosens min/max range would allow a 90-126 target range
        min_bg = round((min_bg - 40) / autosens_data.ratio) + 40;
        max_bg = round((max_bg - 40) / autosens_data.ratio) + 40;
        new_target_bg = round((target_bg - 40) / autosens_data.ratio) + 40;
        if (target_bg == new_target_bg) {
            process.stderr.write("target_bg unchanged: "+new_target_bg+"; ");
        } else {
            process.stderr.write("target_bg from "+target_bg+" to "+new_target_bg+"; ");
        }
        target_bg = new_target_bg;
      }
    }

    if (typeof iob_data === 'undefined' ) {
        rT.error ='Error: iob_data undefined';
        return rT;
    }

    var iobArray = iob_data;
    if (typeof(iob_data.length) && iob_data.length > 1) {
        iob_data = iobArray[0];
        //console.error(JSON.stringify(iob_data[0]));
    }

    if (typeof iob_data.activity === 'undefined' || typeof iob_data.iob === 'undefined' ) {
        rT.error ='Error: iob_data missing some property';
        return rT;
    }

    var tick;

    if (glucose_status.delta > -0.5) {
        tick = "+" + round(glucose_status.delta,0);
    } else {
        tick = round(glucose_status.delta,0);
    }
    //var minDelta = Math.min(glucose_status.delta, glucose_status.short_avgdelta, glucose_status.long_avgdelta);
    var minDelta = Math.min(glucose_status.delta, glucose_status.short_avgdelta);
    var minAvgDelta = Math.min(glucose_status.short_avgdelta, glucose_status.long_avgdelta);

    var sens = profile.sens;
    if (typeof autosens_data !== 'undefined' ) {
        sens = profile.sens / autosens_data.ratio;
        sens = round(sens, 1);
        if (sens != profile.sens) {
            process.stderr.write("sens from "+profile.sens+" to "+sens);
            console.error("");
        }
    }

    //calculate BG impact: the amount BG "should" be rising or falling based on insulin activity alone
    var bgi = round(( -iob_data.activity * sens * 5 ), 2);
    // project deviations for 30 minutes
    var deviation = round( 30 / 5 * ( minDelta - bgi ) );
    // don't overreact to a big negative delta: use minAvgDelta if deviation is negative
    if (deviation < 0) {
        deviation = round( (30 / 5) * ( minAvgDelta - bgi ) );
    }

    // calculate the naive (bolus calculator math) eventual BG based on net IOB and sensitivity
    if (iob_data.iob > 0) {
        var naive_eventualBG = round( bg - (iob_data.iob * sens) );
    } else { // if IOB is negative, be more conservative and use the lower of sens, profile.sens
        var naive_eventualBG = round( bg - (iob_data.iob * Math.min(sens, profile.sens) ) );
    }
    // and adjust it for the deviation above
    var eventualBG = naive_eventualBG + deviation;
    // calculate what portion of that is due to bolussnooze
    var bolusContrib = iob_data.bolussnooze * sens;
    // and add it back in to get snoozeBG, plus another 50% to avoid low-temping at mealtime
    var naive_snoozeBG = round( naive_eventualBG + 1.5 * bolusContrib );
    // adjust that for deviation like we did eventualBG
    var snoozeBG = naive_snoozeBG + deviation;

    // adjust target BG range if needed to safely bring down high BG faster without causing lows
    if ( bg > max_bg && profile.adjust_targets_when_high ) {
        // with target=100, as BG rises from 100 to 140, adjustedTarget drops from 100 to 80
        var adjustedMinBG = Math.max(80, min_bg - (bg - min_bg)/2 );
        var adjustedTargetBG = Math.max(80, target_bg - (bg - target_bg)/2 );
        var adjustedMaxBG = Math.max(80, max_bg - (bg - max_bg)/2 );
        // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedMinBG, don’t use it
        console.error("naive_eventualBG:",naive_eventualBG+", eventualBG:",eventualBG);
        if (eventualBG > adjustedMinBG && naive_eventualBG > adjustedMinBG && min_bg > adjustedMinBG) {
            process.stderr.write("Adjusting min_bg from "+min_bg+" to "+adjustedMinBG+"; ");
            min_bg = adjustedMinBG;
        }
        // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedTargetBG, don’t use it
        if (eventualBG > adjustedTargetBG && naive_eventualBG > adjustedTargetBG && target_bg > adjustedTargetBG) {
            process.stderr.write("target_bg from "+target_bg+" to "+adjustedTargetBG+"; ");
            target_bg = adjustedTargetBG;
        }
        // if eventualBG, naive_eventualBG, and max_bg aren't all above adjustedMaxBG, don’t use it
        if (eventualBG > adjustedMaxBG && naive_eventualBG > adjustedMaxBG && max_bg > adjustedMaxBG) {
            console.error("max_bg from "+max_bg+" to "+adjustedMaxBG);
            max_bg = adjustedMaxBG;
        }
    }

    var expectedDelta = calculate_expected_delta(profile.dia, target_bg, eventualBG, bgi);
    if (typeof eventualBG === 'undefined' || isNaN(eventualBG)) {
        rT.error ='Error: could not calculate eventualBG';
        return rT;
    }

    // min_bg of 90 -> threshold of 65, 100 -> 70 110 -> 75, and 130 -> 85
    var threshold = min_bg - 0.5*(min_bg-40);

    //console.error(reservoir_data);
    var deliverAt = new Date();

    rT = {
        'temp': 'absolute'
        , 'bg': bg
        , 'tick': tick
        , 'eventualBG': eventualBG
        , 'snoozeBG': snoozeBG
        , 'insulinReq': 0
        , 'reservoir' : reservoir_data // The expected reservoir volume at which to deliver the microbolus (the reservoir volume from immediately before the last pumphistory run)
        , 'deliverAt' : deliverAt // The time at which the microbolus should be delivered
    };

    var basaliob = iob_data.basaliob;
    //if (iob_data.basaliob) { basaliob = iob_data.basaliob; }
    //else { basaliob = iob_data.iob - iob_data.bolussnooze; }
    var bolusiob = iob_data.iob - basaliob;

    // generate predicted future BGs based on IOB, COB, and current absorption rate

    var COBpredBGs = [];
    var aCOBpredBGs = [];
    var IOBpredBGs = [];
    var UAMpredBGs = [];
    COBpredBGs.push(bg);
    aCOBpredBGs.push(bg);
    IOBpredBGs.push(bg);
    UAMpredBGs.push(bg);
    // enable UAM (if enabled in preferences) for DIA hours after bolus, or if a low temptarget is set
    var enableUAM=(profile.enableUAM && (bolusiob > 0.1 || (profile.temptargetSet && target_bg < 100) ));
    // enable SMB whenever we have COB or UAM is enabled
    var enableSMB=(enableUAM || meal_data.mealCOB);
    //console.error(meal_data);
    // carb impact and duration are 0 unless changed below
    var ci = 0;
    var cid = 0;
    // calculate current carb absorption rate, and how long to absorb all carbs
    // CI = current carb impact on BG in mg/dL/5m
    ci = round((minDelta - bgi),1);
    uci = round((minAvgDelta - bgi),1);
    // ISF (mg/dL/U) / CR (g/U) = CSF (mg/dL/g)
    var csf = sens / profile.carb_ratio
    // set meal_carbimpact high enough to absorb all meal carbs over 6 hours
    // total_impact (mg/dL) = CSF (mg/dL/g) * carbs (g)
    //console.error(csf * meal_data.carbs);
    // meal_carbimpact (mg/dL/5m) = CSF (mg/dL/g) * carbs (g) / 6 (h) * (1h/60m) * 5 (m/5m) * 2 (for linear decay)
    //var meal_carbimpact = round((csf * meal_data.carbs / 6 / 60 * 5 * 2),1)
    // calculate the number of carbs absorbed over 4h at current CI
    // CI (mg/dL/5m) * (5m)/5 (m) * 60 (min/hr) * 4 (h) / 2 (linear decay factor) = total carb impact (mg/dL)
    var totalCI = Math.max(0, ci / 5 * 60 * 4 / 2);
    // totalCI (mg/dL) / CSF (mg/dL/g) = total carbs absorbed (g)
    var totalCA = totalCI / csf;
    // exclude the last 1/3 of carbs from remainingCarbs, and then cap it at 90
    var remainingCarbs = Math.min(90,Math.max(0, meal_data.mealCOB - totalCA - meal_data.carbs/3));
    // assume remainingCarbs will absorb over 4h
    // remainingCI (mg/dL/5m) = remainingCarbs (g) * CSF (mg/dL/g) * 5 (m/5m) * 1h/60m / 4 (h)
    var remainingCI = remainingCarbs * csf * 5 / 60 / 4;
    //console.error(profile.min_5m_carbimpact,ci,totalCI,totalCA,remainingCarbs,remainingCI);
    //if (meal_data.mealCOB * 3 > meal_data.carbs) { }

    // calculate peak deviation in last hour, and slope from that to current deviation
    var minDeviationSlope = round(meal_data.minDeviationSlope,2);
    //console.error(minDeviationSlope);

    aci = 10;
    //5m data points = g * (1U/10g) * (40mg/dL/1U) / (mg/dL/5m)
    // duration (in 5m data points) = COB (g) * CSF (mg/dL/g) / ci (mg/dL/5m)
    cid = Math.max(0, meal_data.mealCOB * csf / ci );
    acid = Math.max(0, meal_data.mealCOB * csf / aci );
    // duration (hours) = duration (5m) * 5 / 60 * 2 (to account for linear decay)
    console.error("Carb Impact:",ci,"mg/dL per 5m; CI Duration:",round(cid*5/60*2,1),"hours; remaining 4h+ CI:",round(remainingCI,1),"mg/dL per 5m");
    console.error("Accel. Carb Impact:",aci,"mg/dL per 5m; ACI Duration:",round(acid*5/60*2,1),"hours");
    var minIOBPredBG = 999;
    var minCOBPredBG = 999;
    var minUAMPredBG = 999;
    var minPredBG;
    var maxIOBPredBG = bg;
    var maxCOBPredBG = bg;
    var maxUAMPredBG = bg;
    //var maxPredBG = bg;
    var eventualPredBG = bg;
    var lastIOBpredBG;
    var lastCOBpredBG;
    var lastUAMpredBG;
    var UAMduration = 0;
    try {
        iobArray.forEach(function(iobTick) {
            //console.error(iobTick);
            predBGI = round(( -iobTick.activity * sens * 5 ), 2);
            // for IOBpredBGs, predicted deviation impact drops linearly from current deviation down to zero
            // over 60 minutes (data points every 5m)
            predDev = ci * ( 1 - Math.min(1,IOBpredBGs.length/(60/5)) );
            IOBpredBG = IOBpredBGs[IOBpredBGs.length-1] + predBGI + predDev;
            //IOBpredBG = IOBpredBGs[IOBpredBGs.length-1] + predBGI;
            // for COBpredBGs, predicted carb impact drops linearly from current carb impact down to zero
            // eventually accounting for all carbs (if they can be absorbed over DIA)
            predCI = Math.max(0, Math.max(0,ci) * ( 1 - COBpredBGs.length/Math.max(cid*2,1) ) );
            predACI = Math.max(0, Math.max(0,aci) * ( 1 - COBpredBGs.length/Math.max(acid*2,1) ) );
            // if any carbs aren't absorbed after 4 hours, assume they'll absorb at a constant rate for next 4h
            COBpredBG = COBpredBGs[COBpredBGs.length-1] + predBGI + Math.min(0,predDev) + predCI + remainingCI;
            // stop adding remainingCI after 4h
            if (COBpredBGs.length > 4 * 60 / 5) { remainingCI = 0; }
            aCOBpredBG = aCOBpredBGs[aCOBpredBGs.length-1] + predBGI + Math.min(0,predDev) + predACI;
            // for UAMpredBGs, predicted carb impact drops at minDeviationSlope
            // calculate predicted CI from UAM based on minDeviationSlope
            predUCIslope = Math.max(0, uci + ( UAMpredBGs.length*minDeviationSlope ) );
            // if minDeviationSlope is too flat, predicted deviation impact drops linearly from
            // current deviation down to zero over DIA (data points every 5m)
            predUCIdia = Math.max(0, uci * ( 1 - UAMpredBGs.length/Math.max(profile.dia*60/5,1) ) );
            //console.error(predUCIslope, predUCIdia);
            // predicted CI from UAM is the lesser of CI based on deviationSlope or DIA
            predUCI = Math.min(predUCIslope, predUCIdia);
            if(predUCI>0) {
                //console.error(UAMpredBGs.length,minDeviationSlope, predUCI);
                UAMduration=round((UAMpredBGs.length+1)*5/60,1);
            }
            UAMpredBG = UAMpredBGs[UAMpredBGs.length-1] + predBGI + Math.min(0, predDev) + predUCI;
            //console.error(predBGI, predCI, predUCI);
            // truncate all BG predictions at 3.5 hours
            if ( IOBpredBGs.length < 42) { IOBpredBGs.push(IOBpredBG); }
            if ( COBpredBGs.length < 42) { COBpredBGs.push(COBpredBG); }
            if ( aCOBpredBGs.length < 42) { aCOBpredBGs.push(aCOBpredBG); }
            if ( UAMpredBGs.length < 42) { UAMpredBGs.push(UAMpredBG); }
            // wait 90m before setting minIOBPredBG
            if ( IOBpredBGs.length > 18 && (IOBpredBG < minIOBPredBG) ) { minIOBPredBG = IOBpredBG; }
            if ( IOBpredBG > maxIOBPredBG ) { maxIOBPredBG = IOBpredBG; }
            // wait 60m before setting COB and UAM minPredBGs
            if ( cid && COBpredBGs.length > 12 && (COBpredBG < minCOBPredBG) ) { minCOBPredBG = COBpredBG; }
            if ( cid && COBpredBG > maxIOBPredBG ) { maxCOBPredBG = COBpredBG; }
            if ( enableUAM && UAMpredBGs.length > 12 && (UAMpredBG < minUAMPredBG) ) { minUAMPredBG = UAMpredBG; }
            if ( enableUAM && UAMpredBG > maxIOBPredBG ) { maxUAMPredBG = UAMpredBG; }
        });
        // set eventualBG to include effect of carbs
        //console.error("PredBGs:",JSON.stringify(predBGs));
    } catch (e) {
        console.error("Problem with iobArray.  Optional feature Advanced Meal Assist disabled:",e);
    }
    rT.predBGs = {};
    IOBpredBGs.forEach(function(p, i, theArray) {
        theArray[i] = round(Math.min(401,Math.max(39,p)));
    });
    for (var i=IOBpredBGs.length-1; i > 12; i--) {
        if (IOBpredBGs[i-1] != IOBpredBGs[i]) { break; }
        else { IOBpredBGs.pop(); }
    }
    rT.predBGs.IOB = IOBpredBGs;
    lastIOBpredBG=round(IOBpredBGs[IOBpredBGs.length-1]);
    if (meal_data.mealCOB > 0) {
        aCOBpredBGs.forEach(function(p, i, theArray) {
            theArray[i] = round(Math.min(401,Math.max(39,p)));
        });
        for (var i=aCOBpredBGs.length-1; i > 12; i--) {
            if (aCOBpredBGs[i-1] != aCOBpredBGs[i]) { break; }
            else { aCOBpredBGs.pop(); }
        }
        rT.predBGs.aCOB = aCOBpredBGs;
    }
    if (meal_data.mealCOB > 0 && ( ci > 0 || remainingCI > 0 )) {
        COBpredBGs.forEach(function(p, i, theArray) {
            theArray[i] = round(Math.min(401,Math.max(39,p)));
        });
        for (var i=COBpredBGs.length-1; i > 12; i--) {
            if (COBpredBGs[i-1] != COBpredBGs[i]) { break; }
            else { COBpredBGs.pop(); }
        }
        rT.predBGs.COB = COBpredBGs;
        lastCOBpredBG=round(COBpredBGs[COBpredBGs.length-1]);
        eventualBG = Math.max(eventualBG, round(COBpredBGs[COBpredBGs.length-1]) );
    }
    if (ci > 0 || remainingCI > 0) {
        if (enableUAM) {
            UAMpredBGs.forEach(function(p, i, theArray) {
                theArray[i] = round(Math.min(401,Math.max(39,p)));
            });
            for (var i=UAMpredBGs.length-1; i > 12; i--) {
                if (UAMpredBGs[i-1] != UAMpredBGs[i]) { break; }
                else { UAMpredBGs.pop(); }
            }
            rT.predBGs.UAM = UAMpredBGs;
            lastUAMpredBG=round(UAMpredBGs[UAMpredBGs.length-1]);
            eventualBG = Math.max(eventualBG, round(UAMpredBGs[UAMpredBGs.length-1]) );
        }

        // set eventualBG and snoozeBG based on COB or UAM predBGs
        rT.eventualBG = eventualBG;
        //console.error(snoozeBG,minPredBG,minCOBPredBG, minUAMPredBG);
        // Pick the purple line with the highest minimum so we can SMB it down to target
        // if minUAMPredBG or minCOBPredBG have been set, use the higher of those and minIOBPredBG)
    }
    minPredBG = minIOBPredBG;
    if ( minUAMPredBG < 400 ) {
        minPredBG = Math.max(minPredBG, minUAMPredBG);
    }
    if ( minCOBPredBG < 400 ) {
        minPredBG = Math.max(minPredBG, minCOBPredBG);
    }
    // But if the COB line falls off a cliff, don't trust UAM too much:
    // use maxCOBPredBG if it's been set and lower than minPredBG
    if ( maxCOBPredBG > bg ) {
        minPredBG = Math.min(minPredBG, maxCOBPredBG);
    }
    // set snoozeBG to minPredBG if it's higher
    snoozeBG = round(Math.max(snoozeBG,minPredBG));
    rT.snoozeBG = snoozeBG;
    //console.error(minPredBG, minIOBPredBG, minUAMPredBG, minCOBPredBG, maxCOBPredBG, snoozeBG);

    console.error("UAM Impact:",uci,"mg/dL per 5m; UAM Duration:",UAMduration,"hours");

    rT.COB=meal_data.mealCOB;
    rT.IOB=iob_data.iob;
    rT.reason="COB: " + meal_data.mealCOB + ", Dev: " + deviation + ", BGI: " + bgi + ", ISF: " + convert_bg(sens, profile) + ", Target: " + convert_bg(target_bg, profile) + ", IOBpredBG " + convert_bg(lastIOBpredBG, profile);
    if (lastCOBpredBG > 0) {
        rT.reason += ", COBpredBG " + convert_bg(lastCOBpredBG, profile);
    }
    if (lastUAMpredBG > 0) {
        rT.reason += ", UAMpredBG " + convert_bg(lastUAMpredBG, profile)
    }
    rT.reason += "; ";
    if (bg < threshold) { // low glucose suspend mode: BG is < ~80
        rT.reason += "BG " + convert_bg(bg, profile) + "<" + convert_bg(threshold, profile);
        if ((glucose_status.delta <= 0 && minDelta <= 0) || (glucose_status.delta < expectedDelta && minDelta < expectedDelta) || bg < 60 ) {
            // BG is still falling / rising slower than predicted
            return tempBasalFunctions.setTempBasal(0, 30, profile, rT, currenttemp);
        }
        if (glucose_status.delta > minDelta) {
            rT.reason += ", delta " + glucose_status.delta + ">0";
        } else {
            rT.reason += ", min delta " + minDelta.toFixed(2) + ">0";
        }
        if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
            rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
            return rT;
        } else {
            rT.reason += "; setting current basal of " + basal + " as temp";
            return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        }
    }

    if (eventualBG < min_bg) { // if eventual BG is below target:
        rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " < " + convert_bg(min_bg, profile);
        // if 5m or 30m avg BG is rising faster than expected delta
        if (minDelta > expectedDelta && minDelta > 0) {
            // if naive_eventualBG < 40, set a 30m zero temp (oref0-pump-loop will let any longer SMB zero temp run)
            if (naive_eventualBG < 40) {
                rT.reason += ", naive_eventualBG < 40";
                return tempBasalFunctions.setTempBasal(0, 30, profile, rT, currenttemp);
            }
            if (glucose_status.delta > minDelta) {
                rT.reason += ", but Delta " + tick + " > Exp. Delta " + expectedDelta;
            } else {
                rT.reason += ", but Min. Delta " + minDelta.toFixed(2) + " > Exp. Delta " + expectedDelta;
            }
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }

        if (eventualBG < min_bg) {
            // if we've bolused recently, we can snooze until the bolus IOB decays (at double speed)
            if (snoozeBG > min_bg) { // if adding back in the bolus contribution BG would be above min
                // If we're in SMB mode with COB, disable bolus snooze
                if (! (microBolusAllowed && rT.COB)) {
                    rT.reason += ", bolus snooze: eventual BG range " + convert_bg(eventualBG, profile) + "-" + convert_bg(snoozeBG, profile);
                    //console.error(currenttemp, basal );
                    if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                        rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
                        return rT;
                    } else {
                        rT.reason += "; setting current basal of " + basal + " as temp";
                        return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
                    }
                }
            } else {
                // calculate 30m low-temp required to get projected BG up to target
                // use snoozeBG to more gradually ramp in any counteraction of the user's boluses
                // multiply by 2 to low-temp faster for increased hypo safety
                var insulinReq = 2 * Math.min(0, (snoozeBG - target_bg) / sens);
                insulinReq = round( insulinReq , 2);
                // calculate naiveInsulinReq based on naive_eventualBG
                var naiveInsulinReq = Math.min(0, (naive_eventualBG - target_bg) / sens);
                naiveInsulinReq = round( naiveInsulinReq , 2);
                if (minDelta < 0 && minDelta > expectedDelta) {
                    // if we're barely falling, newinsulinReq should be barely negative
                    rT.reason += ", Snooze BG " + convert_bg(snoozeBG, profile);
                    var newinsulinReq = round(( insulinReq * (minDelta / expectedDelta) ), 2);
                    //console.error("Increasing insulinReq from " + insulinReq + " to " + newinsulinReq);
                    insulinReq = newinsulinReq;
                }
                // rate required to deliver insulinReq less insulin over 30m:
                var rate = basal + (2 * insulinReq);
                rate = round_basal(rate, profile);
                // if required temp < existing temp basal
                var insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
                // if current temp would deliver a lot (30% of basal) less than the required insulin,
                // by both normal and naive calculations, then raise the rate
                var minInsulinReq = Math.min(insulinReq,naiveInsulinReq);
                if (insulinScheduled < minInsulinReq - basal*0.3) {
                    rT.reason += ", "+currenttemp.duration + "m@" + (currenttemp.rate).toFixed(2) + " is a lot less than needed";
                    return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
                }
                if (typeof currenttemp.rate !== 'undefined' && (currenttemp.duration > 5 && rate >= currenttemp.rate * 0.8)) {
                    rT.reason += ", temp " + currenttemp.rate + " ~< req " + rate + "U/hr";
                    return rT;
                } else {
                    rT.reason += ", setting " + rate + "U/hr";
                    return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
                }
            }
        }
    }
  
    var minutes_running;
    if (typeof currenttemp.duration == 'undefined' || currenttemp.duration == 0) {
        minutes_running = 30;
    } else if (typeof currenttemp.minutesrunning !== 'undefined'){
        // If the time the current temp is running is not defined, use default request duration of 30 minutes.
        minutes_running = currenttemp.minutesrunning;
    } else {
        minutes_running = 30 - currenttemp.duration;
    }

    // if there is a low-temp running, and eventualBG would be below min_bg without it, let it run
    if (round_basal(currenttemp.rate, profile) < round_basal(basal, profile) ) {
        var lowtempimpact = (currenttemp.rate - basal) * ((30-minutes_running)/60) * sens;
        var adjEventualBG = eventualBG + lowtempimpact;
        // don't return early if microBolusAllowed etc.
        if ( adjEventualBG < min_bg && ! (microBolusAllowed && enableSMB)) {
            rT.reason += "letting low temp of " + currenttemp.rate + " run.";
            return rT;
        }
    }

    // if eventual BG is above min but BG is falling faster than expected Delta
    if (minDelta < expectedDelta) {
        // if in SMB mode, don't cancel SMB zero temp
        if (! (microBolusAllowed && enableSMB)) {
            if (glucose_status.delta < minDelta) {
                rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " > " + convert_bg(min_bg, profile) + " but Delta " + tick + " < Exp. Delta " + expectedDelta;
            } else {
                rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " > " + convert_bg(min_bg, profile) + " but Min. Delta " + minDelta.toFixed(2) + " < Exp. Delta " + expectedDelta;
            }
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }
    }
    // eventualBG, snoozeBG, or minPredBG is below max_bg
    if (Math.min(eventualBG,snoozeBG,minPredBG) < max_bg) {
        // if there is a high-temp running and eventualBG > max_bg, let it run
        if (eventualBG > max_bg && round_basal(currenttemp.rate, profile) > round_basal(basal, profile) ) {
            rT.reason += eventualBG + " > " + max_bg + ": no action required (letting high temp of " + currenttemp.rate + " run)."
            return rT;
        }

        // if in SMB mode, don't cancel SMB zero temp
        if (! (microBolusAllowed && enableSMB )) {
            rT.reason += convert_bg(eventualBG, profile)+"-"+convert_bg(Math.min(minPredBG,snoozeBG), profile)+" in range: no temp required";
            if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
                rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
                return rT;
            } else {
                rT.reason += "; setting current basal of " + basal + " as temp";
                return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
            }
        }
    }

    // eventual BG is at/above target:
    // if iob is over max, just cancel any temps
    var basaliob;
    if (iob_data.basaliob) { basaliob = iob_data.basaliob; }
    else { basaliob = iob_data.iob - iob_data.bolussnooze; }
    rT.reason += "Eventual BG " + convert_bg(eventualBG, profile) + " >= " +  convert_bg(max_bg, profile) + ", ";
    if (basaliob > max_iob) {
        rT.reason += "basaliob " + round(basaliob,2) + " > max_iob " + max_iob;
        if (currenttemp.duration > 15 && (round_basal(basal, profile) === round_basal(currenttemp.rate, profile))) {
            rT.reason += ", temp " + currenttemp.rate + " ~ req " + basal + "U/hr";
            return rT;
        } else {
            rT.reason += "; setting current basal of " + basal + " as temp";
            return tempBasalFunctions.setTempBasal(basal, 30, profile, rT, currenttemp);
        }
    } else { // otherwise, calculate 30m high-temp required to get projected BG down to target

        // insulinReq is the additional insulin required to get minPredBG down to target_bg
        //console.error(minPredBG,snoozeBG,eventualBG);
        var insulinReq = round( (Math.min(minPredBG,snoozeBG,eventualBG) - target_bg) / sens, 2);
        // when dropping, but not as fast as expected, reduce insulinReq proportionally
        // to the what fraction of expectedDelta we're dropping at
        if (minDelta < 0 && minDelta > expectedDelta) {
            var newinsulinReq = round(( insulinReq * (1 - (minDelta / expectedDelta)) ), 2);
            //console.error("Reducing insulinReq from " + insulinReq + " to " + newinsulinReq);
            insulinReq = newinsulinReq;
        }
        // if that would put us over max_iob, then reduce accordingly
        if (insulinReq > max_iob-basaliob) {
            rT.reason += "max_iob " + max_iob + ", ";
            insulinReq = max_iob-basaliob;
        }

        // rate required to deliver insulinReq more insulin over 30m:
        var rate = basal + (2 * insulinReq);
        rate = round_basal(rate, profile);
        insulinReq = round(insulinReq,3);
        rT.insulinReq = insulinReq;
        //console.error(iob_data.lastBolusTime);
        // minutes since last bolus
        var lastBolusAge = round(( new Date().getTime() - iob_data.lastBolusTime ) / 60000,1);
        //console.error(lastBolusAge);
        //console.error(profile.temptargetSet, target_bg, rT.COB);
        // only allow microboluses with COB or low temp targets, or within DIA hours of a bolus
        // only microbolus if insulinReq represents 20m or more of basal
        if (microBolusAllowed && enableSMB) {
            // never bolus more than 30m worth of basal
            maxBolus = profile.current_basal/2;
            // bolus 1/3 the insulinReq, up to maxBolus
            microBolus = round(Math.min(insulinReq/3,maxBolus),1);

            // calculate a long enough zero temp to eventually correct back up to target
            var smbTarget = target_bg;
            //var worstCaseInsulinReq = (smbTarget - naive_eventualBG) / sens + insulinReq/3;
            // only zero-temp for insulin already delivered, to help with intermittent pump comms
            var worstCaseInsulinReq = (smbTarget - naive_eventualBG) / sens;
            var durationReq = round(60*worstCaseInsulinReq / profile.current_basal);
            if (durationReq < 0) {
                durationReq = 0;
            // don't set a temp longer than 120 minutes
            } else {
                durationReq = round(durationReq/30)*30;
                durationReq = Math.min(120,Math.max(0,durationReq));
            }
            //console.error(durationReq);
            rT.reason += "insulinReq " + insulinReq + "; "
            if (durationReq < 0) {
                rT.reason += "setting " + durationReq + "m zero temp;"
            }

            //allow SMBs every 3 minutes
            var nextBolusMins = round(3-lastBolusAge,1);
            //console.error(naive_eventualBG, insulinReq, worstCaseInsulinReq, durationReq);
            console.error("naive_eventualBG",naive_eventualBG+",",durationReq+"m zero temp needed; last bolus",lastBolusAge+"m ago ("+iob_data.lastBolusTime+").");
            if (lastBolusAge > 3) {
                if (microBolus > 0) {
                    rT.units = microBolus;
                    rT.reason += "microbolusing " + microBolus + "U";
                }
            } else {
                rT.reason += "waiting " + nextBolusMins + "m to microbolus again";
            }
            rT.reason += ". ";

            // if no zero temp is required, don't return yet; allow later code to set a high temp
            if (durationReq > 0) {
                rT.rate = 0;
                rT.duration = durationReq;
                return rT;
            }
        }

        var maxSafeBasal = tempBasalFunctions.getMaxSafeBasal(profile);

        if (rate > maxSafeBasal) {
            rT.reason += "adj. req. rate: "+rate+" to maxSafeBasal: "+maxSafeBasal+", ";
            rate = round_basal(maxSafeBasal, profile);
        }

        var insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
        if (insulinScheduled >= insulinReq * 2) { // if current temp would deliver >2x more than the required insulin, lower the rate
            rT.reason += currenttemp.duration + "m@" + (currenttemp.rate).toFixed(2) + " > 2 * insulinReq. Setting temp basal of " + rate + "U/hr";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }

        if (typeof currenttemp.duration == 'undefined' || currenttemp.duration == 0) { // no temp is set
            rT.reason += "no temp, setting " + rate + "U/hr";
            return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
        }

        if (currenttemp.duration > 5 && (round_basal(rate, profile) <= round_basal(currenttemp.rate, profile))) { // if required temp <~ existing temp basal
            rT.reason += "temp " + currenttemp.rate + " >~ req " + rate + "U/hr";
            return rT;
        }

        // required temp > existing temp basal
        rT.reason += "temp " + currenttemp.rate + "<" + rate + "U/hr";
        return tempBasalFunctions.setTempBasal(rate, 30, profile, rT, currenttemp);
    }

};

module.exports = determine_basal;
